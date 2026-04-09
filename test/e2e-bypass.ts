/**
 * E2E bypass — no SDK, direct chain interaction.
 *
 * Flow per action:
 *   1. compile_actions (view call) → server actions
 *   2. Build invoke tx (sender=pool), sign with Bitcoin signer, send to prover
 *   3. Get proof + proof_facts
 *   4. Submit on-chain via AVNU apply_action
 */
import './setup-crypto';
import { RpcProvider, hash, CallData, selector as sel, constants } from 'starknet';
import { LocalBitcoinSigner } from './bitcoin-signer';

// ============================================================
// Config
// ============================================================
const RPC_URL = process.env.VITE_STARKNET_RPC_URL || '';
const PROVING_URL = process.env.VITE_PROVING_SERVICE_URL || '';
const AVNU_URL = process.env.VITE_AVNU_PAYMASTER_URL || '';
const AVNU_KEY = process.env.VITE_AVNU_API_KEY || '';
const POOL = '0x254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91';
const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
// Modified casawybla: Bitcoin signer with Poseidon instead of keccak (no keccak builtin needed)
const ACCOUNT_CLASS_HASH = '0x547b1790e63a72b6a48c18055ae37cfe4191ae8a6980472b4546f07984d2386';
const TEST_PK = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

// Viewing key (must be < EC_ORDER/2)
const EC_ORDER = 0x0800000000000010ffffffffffffffffb781126dcae7b2321e66a241adc64d2fn;
const VIEWING_KEY = '0x' + ((0x12345678deadbeefn % (EC_ORDER / 2n - 1n)) + 1n).toString(16);

const toHex = (v: string) => v.startsWith('0x') ? v : '0x' + BigInt(v).toString(16);

function calculateAddress(pubkeyHash: string): string {
  // Signer::Bitcoin is now variant 2 in the stripped enum (was 5 in original)
  const addr = hash.calculateContractAddressFromHash(pubkeyHash, ACCOUNT_CLASS_HASH, ['2', pubkeyHash, '1'], 0);
  return '0x' + addr.replace(/^0x/, '').padStart(64, '0');
}

function assert(cond: boolean, msg: string) { if (!cond) { console.error('ASSERT FAILED:', msg); process.exit(1); } }

// ============================================================
// Step 1: compile_actions (view call)
// ============================================================
async function compileActions(
  provider: RpcProvider,
  userAddress: string,
  clientActionArgs: string[], // [num_actions, variant, ...fields]
): Promise<string[]> {
  const result = await provider.callContract({
    contractAddress: POOL,
    entrypoint: 'compile_actions',
    calldata: [userAddress, VIEWING_KEY, ...clientActionArgs],
  });
  return result;
}

// ============================================================
// Step 2: Prove (send to proving service)
// ============================================================
async function prove(
  provider: RpcProvider,
  signer: LocalBitcoinSigner,
  userAddress: string,
  clientActionArgs: string[],
): Promise<{ proof: string; proofFacts: string[]; serverActions: string[] }> {
  const chainId = await provider.getChainId();
  const latestBlock = await provider.getBlockNumber();
  const proveBlock = latestBlock - 460;
  const poolNonce = await provider.getNonceForAddress(POOL, { blockIdentifier: proveBlock });

  // Build __execute__ calldata: [1, pool_addr, compile_actions_selector, inner_len, ...inner]
  // Ensure ALL values are hex-prefixed for the RPC
  const innerCalldata = [userAddress, VIEWING_KEY, ...clientActionArgs.map(toHex)].map(toHex);
  const executeCalldata = [
    '0x1',
    POOL,
    sel.getSelectorFromName('compile_actions'),
    '0x' + innerCalldata.length.toString(16),
    ...innerCalldata,
  ];

  // Compute tx hash (pool is sender, zero resource bounds for proving)
  const rb = {
    l1_gas: { max_amount: 0x1n, max_price_per_unit: 0x0n },
    l2_gas: { max_amount: 0x20000000n, max_price_per_unit: 0x0n }, // 536M — Bitcoin sig needs ~300M
    l1_data_gas: { max_amount: 0x0n, max_price_per_unit: 0x0n },
  };

  const txHash = hash.calculateInvokeTransactionHash({
    senderAddress: POOL,
    version: '0x3',
    compiledCalldata: executeCalldata,
    chainId,
    nonce: toHex(poolNonce),
    accountDeploymentData: [],
    nonceDataAvailabilityMode: 0,
    feeDataAvailabilityMode: 0,
    paymasterData: [],
    resourceBounds: rb,
    tip: 0n,
  });

  // Sign with Bitcoin signer
  const signature = signer.signHash(txHash);

  console.log(`  prove block: ${proveBlock}, pool nonce: ${poolNonce}, tx hash: ${txHash}`);

  const rpcBody = {
    jsonrpc: '2.0',
    method: 'starknet_proveTransaction',
    params: {
      block_id: { block_number: proveBlock },
      transaction: {
        type: 'INVOKE',
        version: '0x3',
        sender_address: POOL,
        calldata: executeCalldata,
        signature: signature.map(toHex),
        nonce: toHex(poolNonce),
        resource_bounds: {
          l1_gas: { max_amount: '0x1', max_price_per_unit: '0x0' },
          l2_gas: { max_amount: '0x20000000', max_price_per_unit: '0x0' },
          l1_data_gas: { max_amount: '0x0', max_price_per_unit: '0x0' },
        },
        tip: '0x0',
        paymaster_data: [],
        account_deployment_data: [],
        nonce_data_availability_mode: 'L1',
        fee_data_availability_mode: 'L1',
      },
    },
    id: 1,
  };

  // Find any non-hex values in the body
  const bodyStr = JSON.stringify(rpcBody);
  const nonHex = bodyStr.match(/"(\d+)"/g)?.filter(m => !m.includes('"0x') && m !== '"1"' && m !== '"0"');
  if (nonHex?.length) console.log('  WARNING: non-hex values in body:', nonHex);

  const res = await fetch(PROVING_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: bodyStr,
  });

  const data = await res.json();
  if (data.error) {
    const errData = String(data.error.data || '');
    // Decode felt error messages
    const felts = errData.match(/0x[0-9a-fA-F]{10,64}/g) || [];
    for (const f of felts) {
      try {
        const bytes = Buffer.from(f.slice(2).padStart(f.slice(2).length + (f.slice(2).length % 2), '0'), 'hex');
        const ascii = bytes.toString('ascii').replace(/[^\x20-\x7E]/g, '');
        if (ascii.length > 3) console.log(`  error felt: '${ascii}'`);
      } catch {}
    }
    throw new Error(`Prove error: ${data.error.code} ${data.error.message}: ${String(data.error.data).slice(0, 1000)}`);
  }

  // Also get server actions via compile_actions (view)
  const serverActions = await compileActions(provider, userAddress, clientActionArgs);

  return {
    proof: data.result.proof,
    proofFacts: data.result.proof_facts,
    serverActions,
  };
}

// ============================================================
// Step 3: Submit on-chain via AVNU apply_action
// ============================================================
async function submitViaAvnu(
  provider: RpcProvider,
  serverActions: string[],
  proof: string,
  proofFacts: string[],
): Promise<string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (AVNU_KEY) headers['x-paymaster-api-key'] = AVNU_KEY;

  const applyActionsCall = {
    to: POOL,
    selector: sel.getSelectorFromName('apply_actions'),
    calldata: serverActions.map(toHex),
  };

  const res = await fetch(AVNU_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'paymaster_executeTransaction',
      params: {
        transaction: {
          type: 'apply_action',
          apply_action: {
            apply_actions_call: applyActionsCall,
            proof,
            proof_facts: proofFacts,
          },
        },
        parameters: {
          version: '0x1',
          fee_mode: { mode: 'sponsored' },
        },
      },
      id: 1,
    }),
  });

  const data = await res.json();
  if (data.error) {
    throw new Error(`AVNU error: ${data.error.code} ${data.error.message} ${JSON.stringify(data.error.data || '').slice(0, 1500)}`);
  }

  return data.result.transaction_hash;
}

// ============================================================
// Helpers
// ============================================================
async function getBalance(provider: RpcProvider, address: string): Promise<bigint> {
  const result = await provider.callContract({ contractAddress: STRK, entrypoint: 'balanceOf', calldata: [address] });
  return BigInt(result[0]) + (BigInt(result[1]) << 128n);
}

function formatStrk(wei: bigint): string {
  return `${wei / 10n**18n}.${(wei % 10n**18n).toString().padStart(18, '0').slice(0, 4)} STRK`;
}

async function waitForTx(provider: RpcProvider, txHash: string): Promise<boolean> {
  console.log(`  waiting for ${txHash}...`);
  const receipt = await provider.waitForTransaction(txHash);
  if (receipt.isSuccess()) {
    console.log(`  confirmed, block: ${(receipt.value as any).block_number}`);
    return true;
  }
  console.log(`  REVERTED: ${(receipt.value as any).revert_reason?.slice(0, 200)}`);
  return false;
}

async function deployAccount(provider: RpcProvider, signer: LocalBitcoinSigner, address: string): Promise<void> {
  // Check if already deployed
  try { await provider.getClassHashAt(address); console.log('  already deployed'); return; } catch {}

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
            salt: signer.pubkeyHash,
            calldata: ['0x2', toHex(signer.pubkeyHash), '0x1'], // Signer::Bitcoin(pubkey_hash), None guardian
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
  console.log('  deploy TX:', data.result.transaction_hash);
  await provider.waitForTransaction(data.result.transaction_hash);
  console.log('  deployed!');
}

// ============================================================
// Tests
// ============================================================

async function testSetViewingKey(provider: RpcProvider, signer: LocalBitcoinSigner, userAddress: string) {
  console.log('\n=== SetViewingKey ===');

  // Check if already set
  try {
    const result = await provider.callContract({ contractAddress: POOL, entrypoint: 'get_public_key', calldata: [userAddress] });
    if (result[0] !== '0x0' && result[0] !== '0') {
      console.log('  already set:', result[0].slice(0, 20) + '...');
      return;
    }
  } catch {}

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (AVNU_KEY) headers['x-paymaster-api-key'] = AVNU_KEY;

  // Get fee info
  const feeRes = await fetch(AVNU_URL, {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'paymaster_buildTransaction', params: { transaction: { type: 'apply_action', apply_action: { pool_address: POOL } }, parameters: { version: '0x1', fee_mode: { mode: 'sponsored' } } }, id: 1 }),
  });
  const feeAction = (await feeRes.json()).result?.fee_action;
  const actualFee = feeAction?.amount || '0xde0b6b3a7640000';
  console.log('  fee:', actualFee, 'to', feeAction?.recipient?.slice(0, 12) + '...');

  // Step 1: Approve STRK for the pool (direct tx from user account)
  console.log('  approving STRK...');
  const { Account } = await import('starknet');
  const account = new Account({ provider, address: userAddress, signer, cairoVersion: '1' });
  const approveTx = await account.execute(
    [{ contractAddress: STRK, entrypoint: 'approve', calldata: [POOL, actualFee, '0'] }],
    { tip: 0n, resourceBounds: { l1_gas: { max_amount: 0x200n, max_price_per_unit: 0x800000000000n }, l2_gas: { max_amount: 0xE000000n, max_price_per_unit: 0x4000000000n }, l1_data_gas: { max_amount: 0x200n, max_price_per_unit: 0x800000000000n } } },
  );
  console.log('  approve TX:', approveTx.transaction_hash);
  await waitForTx(provider, approveTx.transaction_hash);

  // Step 2: Prove — SetViewingKey + Deposit(fee) + Withdraw(fee to forwarder)
  const random = '0xdeadbeef' + Date.now().toString(16);
  const feeRandom = '0xfee' + Date.now().toString(16);
  const clientActions = [
    '3',
    '0', random,                    // SetViewingKey
    '5', STRK, actualFee,          // Deposit(fee amount)
    '7',                            // Withdraw(fee to forwarder)
    feeAction.recipient, feeAction.token, actualFee, feeRandom,
  ];

  console.log('  proving...');
  const { proof, proofFacts, serverActions } = await prove(provider, signer, userAddress, clientActions);
  console.log(`  proof: ${proof.length} chars, proof_facts: ${proofFacts.length}, server_actions: ${serverActions.length}`);

  // Step 3: Submit via AVNU apply_action
  console.log('  submitting via AVNU apply_action...');
  const txHash = await submitViaAvnu(provider, serverActions, proof, proofFacts);
  const ok = await waitForTx(provider, txHash);
  assert(ok, 'SetViewingKey rejected');
  console.log('  SetViewingKey PASSED!');
}

async function testDeposit(provider: RpcProvider, signer: LocalBitcoinSigner, userAddress: string) {
  console.log('\n=== Deposit ===');

  // For deposit we need: approve + deposit action + fee withdraw
  // First, get fee_action from AVNU build
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (AVNU_KEY) headers['x-paymaster-api-key'] = AVNU_KEY;

  console.log('  getting fee info from AVNU...');
  const buildRes = await fetch(AVNU_URL, {
    method: 'POST', headers,
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'paymaster_buildTransaction',
      params: {
        transaction: { type: 'apply_action', apply_action: { pool_address: POOL } },
        parameters: { version: '0x1', fee_mode: { mode: 'sponsored' } },
      }, id: 1,
    }),
  });
  const buildData = await buildRes.json();
  const feeAction = buildData.result?.fee_action;
  console.log(`  pool fee: ${feeAction?.amount} ${feeAction?.token?.slice(0, 10)}... to ${feeAction?.recipient?.slice(0, 10)}...`);

  const depositAmount = '2000000000000000000'; // 2 STRK
  const feeAmount = feeAction?.amount || '0';

  // Client actions: SetViewingKey (if needed) + Deposit + fee Withdraw
  // SetViewingKey should already be done, so just Deposit + Withdraw
  const random = '0x' + Math.random().toString(16).slice(2, 14);
  const clientActions = [
    '2',                    // 2 actions
    '5', STRK, depositAmount, // Deposit(STRK, 2e18)
    '7',                    // Withdraw (fee)
    feeAction.recipient,
    feeAction.token,
    feeAmount,
    random,
  ];

  console.log('  proving deposit...');
  const { proof, proofFacts, serverActions } = await prove(provider, signer, userAddress, clientActions);
  console.log(`  proof: ${proof.length} chars, proof_facts: ${proofFacts.length}`);

  // Need to approve STRK before submit
  // We do this via AVNU invoke (user's account calls approve)
  console.log('  approving STRK via AVNU...');
  const approveRes = await fetch(AVNU_URL, {
    method: 'POST', headers,
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'paymaster_buildTransaction',
      params: {
        transaction: {
          type: 'invoke',
          invoke: {
            user_address: userAddress,
            calls: [{
              to: STRK,
              selector: sel.getSelectorFromName('approve'),
              calldata: [POOL, toHex(depositAmount), '0x0'],
            }],
          },
        },
        parameters: { version: '0x1', fee_mode: { mode: 'sponsored' } },
      }, id: 1,
    }),
  });
  const approveData = await approveRes.json();
  if (approveData.error) throw new Error(`Approve build error: ${JSON.stringify(approveData.error)}`);

  // Sign the approve typed data
  const typedData = approveData.result?.typed_data;
  const approveSig = await signer.signMessage(typedData, userAddress);

  const approveExecRes = await fetch(AVNU_URL, {
    method: 'POST', headers,
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'paymaster_executeTransaction',
      params: {
        transaction: {
          type: 'invoke',
          invoke: { user_address: userAddress, typed_data: typedData, signature: approveSig },
        },
        parameters: { version: '0x1', fee_mode: { mode: 'sponsored' } },
      }, id: 1,
    }),
  });
  const approveExecData = await approveExecRes.json();
  if (approveExecData.error) throw new Error(`Approve exec error: ${JSON.stringify(approveExecData.error)}`);
  console.log('  approve TX:', approveExecData.result.transaction_hash);
  await waitForTx(provider, approveExecData.result.transaction_hash);

  // Now submit the deposit via AVNU apply_action
  console.log('  submitting deposit via AVNU...');
  const txHash = await submitViaAvnu(provider, serverActions, proof, proofFacts);
  const ok = await waitForTx(provider, txHash);
  assert(ok, 'Deposit rejected');
  console.log('  Deposit PASSED!');
}

async function testWithdraw(provider: RpcProvider, signer: LocalBitcoinSigner, userAddress: string) {
  console.log('\n=== Withdraw ===');

  // Get fee info
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (AVNU_KEY) headers['x-paymaster-api-key'] = AVNU_KEY;

  const buildRes = await fetch(AVNU_URL, {
    method: 'POST', headers,
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'paymaster_buildTransaction',
      params: {
        transaction: { type: 'apply_action', apply_action: { pool_address: POOL } },
        parameters: { version: '0x1', fee_mode: { mode: 'sponsored' } },
      }, id: 1,
    }),
  });
  const feeAction = (await buildRes.json()).result?.fee_action;

  const withdrawAmount = '500000000000000000'; // 0.5 STRK
  const feeAmount = feeAction?.amount || '0';
  const random1 = '0x' + Math.random().toString(16).slice(2, 14);
  const random2 = '0x' + Math.random().toString(16).slice(2, 14);

  // Client actions: Withdraw(to self) + Withdraw(fee to forwarder)
  const clientActions = [
    '2',
    '7', userAddress, STRK, withdrawAmount, random1,       // Withdraw to self
    '7', feeAction.recipient, feeAction.token, feeAmount, random2, // Withdraw fee
  ];

  console.log('  proving withdraw...');
  const { proof, proofFacts, serverActions } = await prove(provider, signer, userAddress, clientActions);
  console.log(`  proof: ${proof.length} chars, proof_facts: ${proofFacts.length}`);

  console.log('  submitting via AVNU...');
  const txHash = await submitViaAvnu(provider, serverActions, proof, proofFacts);
  const ok = await waitForTx(provider, txHash);
  assert(ok, 'Withdraw rejected');
  console.log('  Withdraw PASSED!');
}

// ============================================================
// Main
// ============================================================
async function main() {
  console.log('STRK20 Privacy Pool E2E (bypass, no SDK)\n');

  if (!AVNU_KEY) { console.error('Set VITE_AVNU_API_KEY'); process.exit(1); }

  const provider = new RpcProvider({ nodeUrl: RPC_URL });
  const signer = new LocalBitcoinSigner(TEST_PK);
  const userAddress = calculateAddress(signer.pubkeyHash);

  console.log('user:', userAddress);
  console.log('pubkey_hash:', signer.pubkeyHash);

  // Always deploy first
  console.log('\nDeploying account...');
  await deployAccount(provider, signer, userAddress);
  console.log('balance:', formatStrk(await getBalance(provider, userAddress)));

  const step = process.argv[2] || 'viewkey';

  if (step === 'viewkey' || step === 'all') await testSetViewingKey(provider, signer, userAddress);
  if (step === 'deposit' || step === 'all') await testDeposit(provider, signer, userAddress);
  if (step === 'withdraw' || step === 'all') await testWithdraw(provider, signer, userAddress);

  if (step === 'all') {
    console.log('\n=== ALL TESTS PASSED ===');
    console.log('final balance:', formatStrk(await getBalance(provider, userAddress)));
  }
}

main().catch(e => {
  console.error('\nFATAL:', e.message?.slice(0, 500) || e);
  process.exit(1);
});
