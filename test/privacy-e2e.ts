/**
 * Full E2E: Deploy casawybla account + Privacy SDK deposit/withdraw
 *
 * Uses:
 * - casawybla ArgentAccount with Bitcoin signer (local private key emulating Ledger)
 * - starknet-privacy SDK for privacy pool interactions
 * - AVNU paymaster for private transaction submission
 */
import './setup-crypto';
import { Account, RpcProvider, hash, constants } from 'starknet';
import { createPrivateTransfers } from '@starkware-libs/starknet-privacy-sdk';
import { LocalBitcoinSigner, derivePubkeyHash } from './bitcoin-signer';

// ============================================================
// Config
// ============================================================
const RPC_URL = process.env.VITE_STARKNET_RPC_URL || '';
const PROVING_URL = process.env.VITE_PROVING_SERVICE_URL || '';
const DISCOVERY_URL = process.env.VITE_DISCOVERY_SERVICE_URL || '';
const POOL_ADDRESS = '0x254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91';
const STRK_TOKEN = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const ACCOUNT_CLASS_HASH = '0x547b1790e63a72b6a48c18055ae37cfe4191ae8a6980472b4546f07984d2386';

// Test private key (Hardhat #0 — DO NOT use with real funds)
const TEST_PK = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

// Privacy viewing key (deterministic for testing, must be < EC_ORDER/2)
const EC_ORDER = 0x0800000000000010ffffffffffffffffb781126dcae7b2321e66a241adc64d2fn;
const VIEWING_KEY = (0x12345678deadbeefn % (EC_ORDER / 2n - 1n)) + 1n;

// ============================================================
// Helpers
// ============================================================

function calculateAddress(pubkeyHash: string): string {
  const calldata = ['2', pubkeyHash, '1'];
  const addr = hash.calculateContractAddressFromHash(pubkeyHash, ACCOUNT_CLASS_HASH, calldata, 0);
  return '0x' + addr.replace(/^0x/, '').padStart(64, '0');
}

async function getBalance(provider: RpcProvider, address: string): Promise<bigint> {
  const result = await provider.callContract({
    contractAddress: STRK_TOKEN,
    entrypoint: 'balanceOf',
    calldata: [address],
  });
  return BigInt(result[0]) + (BigInt(result[1]) << 128n);
}

function formatStrk(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, '0').slice(0, 4);
  return `${whole}.${frac} STRK`;
}

// ============================================================
// Step 1: Deploy account
// ============================================================

async function deployAccount(provider: RpcProvider, signer: LocalBitcoinSigner): Promise<string> {
  const pubkeyHash = signer.pubkeyHash;
  const address = calculateAddress(pubkeyHash);

  console.log('Account address:', address);
  console.log('Pubkey hash:', pubkeyHash);

  // Check if already deployed
  try {
    await provider.getClassHashAt(address);
    console.log('Already deployed!');
    return address;
  } catch {}

  // Deploy via AVNU paymaster (sponsored)
  console.log('Deploying via AVNU paymaster...');
  const AVNU_URL = process.env.VITE_AVNU_PAYMASTER_URL || '';
  const AVNU_KEY = process.env.VITE_AVNU_API_KEY || '';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (AVNU_KEY) headers['x-paymaster-api-key'] = AVNU_KEY;

  const res = await fetch(AVNU_URL, {
    method: 'POST', headers,
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'paymaster_executeTransaction',
      params: {
        transaction: {
          type: 'deploy',
          deployment: {
            address,
            class_hash: ACCOUNT_CLASS_HASH,
            salt: pubkeyHash,
            calldata: ['0x5', pubkeyHash, '0x1'],
            version: 1,
          },
        },
        parameters: { version: '0x1', fee_mode: { mode: 'sponsored' } },
      },
      id: 1,
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Deploy error: ${JSON.stringify(data.error)}`);

  console.log('Deploy TX:', data.result.transaction_hash);
  await provider.waitForTransaction(data.result.transaction_hash);
  console.log('Deployed!');
  return address;
}

// ============================================================
// Step 2: Privacy pool interactions via SDK
// ============================================================

async function testPrivacy(provider: RpcProvider, signer: LocalBitcoinSigner, address: string) {
  console.log('\n=== Privacy Pool Tests ===\n');

  const account = new Account({ provider, address, signer, cairoVersion: '1' });

  const transfers = createPrivateTransfers({
    account,
    viewingKeyProvider: { getViewingKey: async () => VIEWING_KEY },
    provingProvider: {
      url: PROVING_URL,
      chainId: constants.StarknetChainId.SN_SEPOLIA,
    },
    discoveryProvider: { url: DISCOVERY_URL },
    poolContractAddress: POOL_ADDRESS,
  });

  console.log('SDK initialized for user:', address);

  // Skip register — viewing key already set from direct-submit test
  // Go straight to deposit
  console.log('\n--- Deposit 0.01 STRK ---');
  const depResult = await transfers.build({ autoRegister: false, autoSetup: true, autoSelectNotes: 'all' })
    .with(STRK_TOKEN, (t: any) => t.deposit({ amount: 10000000000000000n }))
    .surplusTo(address)
    .execute();
  console.log('Register call:', regResult.callAndProof.call.entrypoint);
  console.log('Proof facts:', regResult.callAndProof.proof.proofFacts?.length, 'elements');
  console.log('Warnings:', regResult.warnings);

  // Submit via account.execute (or AVNU paymaster)
  // The SDK returns a call + proof; we submit it
  const regTx = await account.execute(
    [regResult.callAndProof.call],
    {
      resourceBounds: {
        l1_gas: { max_amount: 0x200n, max_price_per_unit: 0x400000000000n },
        l2_gas: { max_amount: 0x2000000n, max_price_per_unit: 0x1000000000n },
        l1_data_gas: { max_amount: 0x200n, max_price_per_unit: 0x400000000000n },
      },
    },
  );
  console.log('Register TX:', regTx.transaction_hash);
  await provider.waitForTransaction(regTx.transaction_hash);
  console.log('Register confirmed!');

  // Deposit
  console.log('\n--- Deposit 0.001 STRK ---');
  const depositResult = await transfers.build({ autoRegister: true, autoSetup: true })
    .with(STRK_TOKEN, (t) => t.deposit({ amount: 1000000000000000n }))
    .surplusTo(address)
    .execute();
  console.log('Deposit call:', depositResult.callAndProof.call.entrypoint);

  // For deposit we need an approve + apply_actions
  // The SDK should handle this — let's see what call it produces
  const depositTx = await account.execute(
    [depositResult.callAndProof.call],
    {
      resourceBounds: {
        l1_gas: { max_amount: 0x200n, max_price_per_unit: 0x400000000000n },
        l2_gas: { max_amount: 0x2000000n, max_price_per_unit: 0x1000000000n },
        l1_data_gas: { max_amount: 0x200n, max_price_per_unit: 0x400000000000n },
      },
    },
  );
  console.log('Deposit TX:', depositTx.transaction_hash);
  await provider.waitForTransaction(depositTx.transaction_hash);
  console.log('Deposit confirmed!');

  // Withdraw
  console.log('\n--- Withdraw 0.0005 STRK ---');
  const withdrawResult = await transfers.build({ autoSelectNotes: 'all' })
    .with(STRK_TOKEN, (t) =>
      t.withdraw({ recipient: address, amount: 500000000000000n }))
    .surplusTo(address)
    .execute();

  const withdrawTx = await account.execute(
    [withdrawResult.callAndProof.call],
    {
      resourceBounds: {
        l1_gas: { max_amount: 0x200n, max_price_per_unit: 0x400000000000n },
        l2_gas: { max_amount: 0x2000000n, max_price_per_unit: 0x1000000000n },
        l1_data_gas: { max_amount: 0x200n, max_price_per_unit: 0x400000000000n },
      },
    },
  );
  console.log('Withdraw TX:', withdrawTx.transaction_hash);
  await provider.waitForTransaction(withdrawTx.transaction_hash);
  console.log('Withdraw confirmed!');

  console.log('\n=== ALL TESTS PASSED ===');
}

// ============================================================
// Main
// ============================================================

async function main() {
  console.log('SNIP-36 Privacy Pool E2E (casawybla + SDK)\n');

  const provider = new RpcProvider({ nodeUrl: RPC_URL });
  const signer = new LocalBitcoinSigner(TEST_PK);

  console.log('Pubkey hash:', signer.pubkeyHash);
  const address = calculateAddress(signer.pubkeyHash);
  console.log('Expected address:', address);

  const balance = await getBalance(provider, address);
  console.log('Balance:', formatStrk(balance));

  const step = process.argv[2] || 'all';

  if (step === 'deploy' || step === 'all') {
    await deployAccount(provider, signer);
  }

  if (step === 'fund') {
    console.log(`\nFund this address with STRK:\n${address}`);
    return;
  }

  if (balance === 0n && step === 'all') {
    console.log(`\nAccount needs funding. Run:\n  npx tsx test/privacy-e2e.ts fund`);
    return;
  }

  if (step === 'privacy' || step === 'all') {
    await testPrivacy(provider, signer, address);
  }
}

main().catch(e => {
  console.error('\nFATAL:', e.message?.slice(0, 500) || e);
  if (e.stack) console.error(e.stack.split('\n').slice(0, 10).join('\n'));
  process.exit(1);
});
