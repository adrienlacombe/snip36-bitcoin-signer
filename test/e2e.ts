/**
 * E2E Integration Tests for SNIP-36 EVM Privacy Pool
 *
 * Run:  VITE_AVNU_API_KEY=<key> npx tsx test/e2e.ts [step]
 *
 * Steps:
 *   setup    — deploy accounts A and B
 *   deposit  — A: deposit + withdraw to self via privacy pool
 *   transfer — A → B: private transfer via CreateEncNote
 *   withdraw — A: standalone withdraw from privacy pool
 *   all      — setup + deposit + transfer
 */
import {
  extractPubKeyCoords,
  computeStarknetAddress,
  deployViaPaymaster,
  deployAccountDirect,
  isDeployed,
  getStrkBalance,
  waitForTx,
  derivePrivacyKey,
  signAndExecuteInvoke,
  directInvoke,
  proveAndExecute,
  formatStrk,
  getProvider,
  deriveStarkPublicKey,
  computeChannelKey,
  generateRandom120,
  PRIVACY_POOL_ADDRESS,
  STRK_TOKEN_ADDRESS,
  AVNU_API_KEY,
  PROVING_SERVICE_URL,
} from './e2e-helpers';

// ============================================================
// Test private keys (Hardhat #0 and #1 — DO NOT use with real funds)
// ============================================================
const TEST_PRIVATE_KEY_A = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TEST_PRIVATE_KEY_B = '59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

// ============================================================
// Helpers
// ============================================================

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`ASSERTION FAILED: ${msg}`);
    process.exit(1);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================
// Step 1: Setup — Compute address and deploy
// ============================================================

async function deployAccount(name: string, privateKey: string, sponsor?: { privateKey: string; address: string }) {
  console.log(`\n--- ${name} ---`);
  const pubKey = extractPubKeyCoords(privateKey);
  const { address, salt, constructorCalldata } = computeStarknetAddress(pubKey);
  console.log('  Address:', address);

  const deployed = await isDeployed(address);
  if (deployed) {
    console.log('  Already deployed');
  } else {
    // Try paymaster first; fall back to direct deploy funded by sponsor
    let success = false;
    try {
      console.log('  Deploying via AVNU paymaster...');
      const txHash = await deployViaPaymaster({ address, salt, constructorCalldata });
      console.log('  Deploy TX:', txHash);
      const status = await waitForTx(txHash);
      assert(status === 'accepted', `${name} deploy rejected`);
      console.log('  Deploy confirmed!');
      success = true;
    } catch (e: any) {
      if (e.message?.includes('deployed') || e.message?.includes('ALREADY')) {
        console.log('  Already deployed (race condition OK)');
        success = true;
      } else if (sponsor) {
        console.log('  Paymaster unavailable, deploying via sponsor...');
        // Fund enough for EthAccount deploy (secp256k1 verify is gas-heavy)
        const fundAmount = 5000000000000000000n; // 5 STRK
        const fundTx = await directInvoke({
          privateKeyHex: sponsor.privateKey,
          starknetAddress: sponsor.address,
          calls: [{
            contractAddress: STRK_TOKEN_ADDRESS,
            entrypoint: 'transfer',
            calldata: [address, fundAmount.toString(), '0'],
          }],
        });
        console.log('  Fund TX:', fundTx);
        await waitForTx(fundTx);
        // Deploy using the account's own gas
        const deployTx = await deployAccountDirect({
          privateKeyHex: privateKey,
          address,
          salt,
          constructorCalldata,
        });
        console.log('  Deploy TX:', deployTx);
        const deployStatus = await waitForTx(deployTx);
        assert(deployStatus === 'accepted', `${name} deploy rejected`);
        console.log('  Deploy confirmed (sponsor-funded)!');
        success = true;
      } else {
        throw e;
      }
    }
    assert(success, `${name} deploy failed`);
  }

  const balance = await getStrkBalance(address);
  console.log(`  Balance: ${formatStrk(balance)}`);
  return { address, pubKey, salt, constructorCalldata, balance };
}

async function setup() {
  console.log('\n=== STEP 1: Setup ===\n');

  const a = await deployAccount('Wallet A', TEST_PRIVATE_KEY_A);
  const b = await deployAccount('Wallet B', TEST_PRIVATE_KEY_B, {
    privateKey: TEST_PRIVATE_KEY_A,
    address: a.address,
  });

  if (a.balance === 0n) {
    console.log('\n╔══════════════════════════════════════════════════════╗');
    console.log('║  FUND WALLET A WITH STRK:                            ║');
    console.log(`║  ${a.address} ║`);
    console.log('╚══════════════════════════════════════════════════════╝');
  }

  return { addressA: a.address, addressB: b.address };
}

// ============================================================
// Step 2: Privacy pool integration — compile, prove, submit
// ============================================================

async function deposit() {
  console.log('\n=== STEP 2: Privacy Pool Integration ===\n');

  const pubKey = extractPubKeyCoords(TEST_PRIVATE_KEY_A);
  const { address } = computeStarknetAddress(pubKey);
  console.log('Account:', address);

  // Check balance
  const balance = await getStrkBalance(address);
  console.log('Balance:', formatStrk(balance));
  assert(balance > 0n, 'Account has no STRK balance — fund it first');

  // Derive privacy key
  const privacyKey = derivePrivacyKey(TEST_PRIVATE_KEY_A, address);
  console.log('Privacy key:', privacyKey);

  const provider = getProvider();

  const randomFelt = () => {
    const bytes = new Uint8Array(31);
    crypto.getRandomValues(bytes);
    return '0x' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  };

  // Check if viewing key is set — if not, register it via full prove pipeline
  let needsViewingKey = true;
  try {
    const pubKeyResult = await provider.callContract({
      contractAddress: PRIVACY_POOL_ADDRESS,
      entrypoint: 'get_public_key',
      calldata: [address],
    });
    if (pubKeyResult[0] !== '0x0' && pubKeyResult[0] !== '0') {
      needsViewingKey = false;
      console.log('  Viewing key already set');
    }
  } catch {
    // Not set yet
  }

  if (needsViewingKey) {
    // Full pipeline: compile_actions → prove (pool as sender) → sign with proof_facts → raw RPC submit
    console.log('\nSetting viewing key via proving service...');
    const vkClientActions = [address, privacyKey, '1', '0', randomFelt()];
    const vkServerActions = await provider.callContract({
      contractAddress: PRIVACY_POOL_ADDRESS,
      entrypoint: 'compile_actions',
      calldata: vkClientActions,
    });
    console.log('  Compiled, proving and executing...');
    const vkTx = await proveAndExecute({
      privateKeyHex: TEST_PRIVATE_KEY_A,
      starknetAddress: address,
      clientActions: vkClientActions,
      serverActions: [...vkServerActions],
    });
    console.log('  ViewingKey TX:', vkTx);
    const vkStatus = await waitForTx(vkTx);
    assert(vkStatus === 'accepted', 'SetViewingKey transaction rejected');
    console.log('\n  Full pipeline verified: compile → prove → sign(proof_facts) → submit → confirmed');
  } else {
    console.log('  Viewing key already registered — pipeline was verified on first run');
  }

  // Verify the viewing key is now set
  const pubKeyCheck = await provider.callContract({
    contractAddress: PRIVACY_POOL_ADDRESS,
    entrypoint: 'get_public_key',
    calldata: [address],
  });
  assert(pubKeyCheck[0] !== '0x0' && pubKeyCheck[0] !== '0', 'Viewing key not set after registration');
  console.log('  On-chain viewing key:', pubKeyCheck[0].slice(0, 16) + '...');

  // Step 2c: Deposit + Withdraw through the privacy pool
  // OpenChannel provides WriteOnce replay protection, Deposit+Withdraw net to zero balance.
  const depositAmount = 1000000000000000n; // 0.001 STRK
  console.log(`\nDeposit + Withdraw ${formatStrk(depositAmount)} through privacy pool...`);

  // Approve STRK spending by privacy pool
  console.log('  Approving STRK...');
  const approveTxHash = await directInvoke({
    privateKeyHex: TEST_PRIVATE_KEY_A,
    starknetAddress: address,
    calls: [{
      contractAddress: STRK_TOKEN_ADDRESS,
      entrypoint: 'approve',
      calldata: [PRIVACY_POOL_ADDRESS, depositAmount.toString(), '0'],
    }],
  });
  console.log('  Approve TX:', approveTxHash);
  const approveStatus = await waitForTx(approveTxHash);
  assert(approveStatus === 'accepted', 'Approve transaction rejected');

  // Compile: OpenChannel + Deposit + Withdraw(same amount)
  // Channel index must be unique per run (WriteOnce — reusing an index reverts with NON_ZERO_VALUE)
  const channelIndex = '0x' + BigInt(Math.floor(Date.now() / 1000)).toString(16); // seconds, fits u32
  const depositClientActions = [
    address, privacyKey,
    '3',                                                   // 3 actions
    '1', address, channelIndex, randomFelt(), randomFelt(), // OpenChannel(to_self, index, rand, rand)
    '5', STRK_TOKEN_ADDRESS, depositAmount.toString(),     // Deposit(token, amount)
    '7', address, STRK_TOKEN_ADDRESS, depositAmount.toString(), randomFelt(), // Withdraw(to_self, token, amount, rand)
  ];
  const depositServerActions = await provider.callContract({
    contractAddress: PRIVACY_POOL_ADDRESS,
    entrypoint: 'compile_actions',
    calldata: depositClientActions,
  });
  console.log('  Compiled:', depositServerActions.length, 'server action felts');

  // Prove and execute
  const depositTxHash = await proveAndExecute({
    privateKeyHex: TEST_PRIVATE_KEY_A,
    starknetAddress: address,
    clientActions: depositClientActions,
    serverActions: [...depositServerActions],
  });
  console.log('  Deposit+Withdraw TX:', depositTxHash);
  const depositStatus = await waitForTx(depositTxHash);
  assert(depositStatus === 'accepted', 'Deposit+Withdraw transaction rejected');

  const balanceAfter = await getStrkBalance(address);
  console.log(`  Balance after: ${formatStrk(balanceAfter)}`);

  console.log('\nDEPOSIT + WITHDRAW TEST PASSED!\n');
}

// ============================================================
// Step 3: Private transfer A → B via CreateEncNote
// ============================================================

async function transfer() {
  console.log('\n=== STEP 3: Private Transfer A → B ===\n');

  const provider = getProvider();

  // Derive addresses and keys for both wallets
  const pubKeyA = extractPubKeyCoords(TEST_PRIVATE_KEY_A);
  const { address: addrA } = computeStarknetAddress(pubKeyA);
  const privacyKeyA = derivePrivacyKey(TEST_PRIVATE_KEY_A, addrA);

  const pubKeyB = extractPubKeyCoords(TEST_PRIVATE_KEY_B);
  const { address: addrB } = computeStarknetAddress(pubKeyB);
  const privacyKeyB = derivePrivacyKey(TEST_PRIVATE_KEY_B, addrB);

  console.log('Wallet A:', addrA);
  console.log('Wallet B:', addrB);

  // Ensure B has gas for viewing key registration
  const balB = await getStrkBalance(addrB);
  if (balB < 500000000000000n) { // < 0.0005 STRK
    console.log('\nFunding Wallet B with gas from Wallet A...');
    const fundAmount = 1000000000000000000n; // 1 STRK
    const fundTx = await directInvoke({
      privateKeyHex: TEST_PRIVATE_KEY_A,
      starknetAddress: addrA,
      calls: [{
        contractAddress: STRK_TOKEN_ADDRESS,
        entrypoint: 'transfer',
        calldata: [addrB, fundAmount.toString(), '0'],
      }],
    });
    console.log('  Fund TX:', fundTx);
    const fundStatus = await waitForTx(fundTx);
    assert(fundStatus === 'accepted', 'Fund transfer rejected');
    console.log('  Wallet B funded:', formatStrk(await getStrkBalance(addrB)));
  }

  // Register B's viewing key if not already set
  const randomFelt = () => {
    const bytes = new Uint8Array(31);
    crypto.getRandomValues(bytes);
    return '0x' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  };

  let bNeedsViewingKey = true;
  try {
    const bPubResult = await provider.callContract({
      contractAddress: PRIVACY_POOL_ADDRESS,
      entrypoint: 'get_public_key',
      calldata: [addrB],
    });
    if (bPubResult[0] !== '0x0' && bPubResult[0] !== '0') {
      bNeedsViewingKey = false;
      console.log('  Wallet B viewing key already set');
    }
  } catch { /* not set */ }

  if (bNeedsViewingKey) {
    console.log('\nRegistering Wallet B viewing key...');
    const vkActions = [addrB, privacyKeyB, '1', '0', randomFelt()];
    const vkServer = await provider.callContract({
      contractAddress: PRIVACY_POOL_ADDRESS,
      entrypoint: 'compile_actions',
      calldata: vkActions,
    });
    const vkTx = await proveAndExecute({
      privateKeyHex: TEST_PRIVATE_KEY_B,
      starknetAddress: addrB,
      clientActions: vkActions,
      serverActions: [...vkServer],
    });
    console.log('  ViewingKey TX:', vkTx);
    const vkStatus = await waitForTx(vkTx);
    assert(vkStatus === 'accepted', 'Wallet B SetViewingKey rejected');
  }

  // Get B's on-chain public key (Stark curve, set during SetViewingKey)
  const bPubKeyResult = await provider.callContract({
    contractAddress: PRIVACY_POOL_ADDRESS,
    entrypoint: 'get_public_key',
    calldata: [addrB],
  });
  const bStarkPubKey = bPubKeyResult[0];
  console.log('  B Stark public key:', bStarkPubKey.slice(0, 16) + '...');

  // Compute channel key for A → B
  const channelKey = computeChannelKey(addrA, privacyKeyA, addrB, bStarkPubKey);
  console.log('  Channel key A→B:', channelKey.slice(0, 16) + '...');

  // Approve STRK for the privacy pool
  const transferAmount = 1000000000000000n; // 0.001 STRK
  console.log(`\nPrivate transfer ${formatStrk(transferAmount)} from A to B...`);
  console.log('  Approving STRK...');
  const approveTx = await directInvoke({
    privateKeyHex: TEST_PRIVATE_KEY_A,
    starknetAddress: addrA,
    calls: [{
      contractAddress: STRK_TOKEN_ADDRESS,
      entrypoint: 'approve',
      calldata: [PRIVACY_POOL_ADDRESS, transferAmount.toString(), '0'],
    }],
  });
  console.log('  Approve TX:', approveTx);
  const approveStatus = await waitForTx(approveTx);
  assert(approveStatus === 'accepted', 'Approve rejected');

  // Build action batch: OpenChannel + OpenSubchannel + Deposit + CreateEncNote
  // This deposits STRK and creates an encrypted note for B (nets to zero balance).
  const channelIndex = '0x' + BigInt(Math.floor(Date.now() / 1000)).toString(16); // seconds, fits u32
  const clientActions = [
    addrA, privacyKeyA,
    '4',                                                           // 4 actions
    // OpenChannel (variant 1): recipient, index, random, salt
    '1', addrB, channelIndex, randomFelt(), randomFelt(),
    // OpenSubchannel (variant 2): recipient, recipient_pub_key, channel_key, index, token, salt
    '2', addrB, bStarkPubKey, channelKey, '0', STRK_TOKEN_ADDRESS, randomFelt(),
    // Deposit (variant 5): token, amount
    '5', STRK_TOKEN_ADDRESS, transferAmount.toString(),
    // CreateEncNote (variant 3): recipient, recipient_pub_key, token, amount, index, salt
    '3', addrB, bStarkPubKey, STRK_TOKEN_ADDRESS, transferAmount.toString(), '0', generateRandom120(),
  ];

  console.log('  Compiling actions...');
  const serverActions = await provider.callContract({
    contractAddress: PRIVACY_POOL_ADDRESS,
    entrypoint: 'compile_actions',
    calldata: clientActions,
  });
  console.log('  Compiled:', serverActions.length, 'server action felts');

  // Prove and execute
  const txHash = await proveAndExecute({
    privateKeyHex: TEST_PRIVATE_KEY_A,
    starknetAddress: addrA,
    clientActions,
    serverActions: [...serverActions],
  });
  console.log('  Transfer TX:', txHash);
  const txStatus = await waitForTx(txHash);
  assert(txStatus === 'accepted', 'Private transfer rejected');

  const balAfterA = await getStrkBalance(addrA);
  console.log(`\n  A balance after: ${formatStrk(balAfterA)}`);
  console.log('\nPRIVATE TRANSFER TEST PASSED!\n');
}

// ============================================================
// Step 4: Withdraw STRK from privacy pool
// ============================================================

async function withdraw() {
  console.log('\n=== STEP 3: Withdraw ===\n');

  const pubKey = extractPubKeyCoords(TEST_PRIVATE_KEY_A);
  const { address } = computeStarknetAddress(pubKey);
  console.log('Account:', address);

  const balanceBefore = await getStrkBalance(address);
  console.log('Balance before:', formatStrk(balanceBefore));

  // Derive privacy key
  const privacyKey = derivePrivacyKey(TEST_PRIVATE_KEY_A, address);

  // Withdraw amount: 0.0005 STRK (half of what we deposited)
  const withdrawAmount = 500000000000000n; // 0.0005 * 10^18

  // Random felt for withdraw
  const randomBytes = new Uint8Array(31);
  crypto.getRandomValues(randomBytes);
  const withdrawRandom = '0x' + Array.from(randomBytes).map((b) => b.toString(16).padStart(2, '0')).join('');

  // Build withdraw client actions
  // Withdraw variant (index 7): to_addr, token, amount, random
  const withdrawClientActions = [
    address,
    privacyKey,
    '1',                        // 1 action
    '7',                        // Withdraw variant index
    address,                    // to_addr (withdraw to self)
    STRK_TOKEN_ADDRESS,         // token
    withdrawAmount.toString(),  // amount
    withdrawRandom,             // random
  ];

  // Compile actions
  console.log('Compiling withdraw action...');
  const provider = getProvider();
  const withdrawServerActions = await provider.callContract({
    contractAddress: PRIVACY_POOL_ADDRESS,
    entrypoint: 'compile_actions',
    calldata: withdrawClientActions,
  });
  console.log('  Server actions:', withdrawServerActions.length, 'felts');

  // Prove and execute apply_actions (withdraw)
  console.log('\nProving and executing apply_actions (withdraw)...');
  const txHash = await proveAndExecute({
    privateKeyHex: TEST_PRIVATE_KEY_A,
    starknetAddress: address,
    clientActions: withdrawClientActions,
    serverActions: [...withdrawServerActions],
  });
  console.log('  Withdraw TX:', txHash);
  const status = await waitForTx(txHash);
  assert(status === 'accepted', 'Withdraw transaction rejected');

  const balanceAfter = await getStrkBalance(address);
  console.log(`\nBalance after withdraw: ${formatStrk(balanceAfter)}`);
  console.log('WITHDRAW TEST PASSED!\n');
}

// ============================================================
// Main
// ============================================================

async function main() {
  console.log('SNIP-36 EVM — E2E Integration Tests');
  console.log('====================================');

  if (!AVNU_API_KEY) {
    console.error('ERROR: Set VITE_AVNU_API_KEY environment variable');
    process.exit(1);
  }
  if (!PROVING_SERVICE_URL) {
    console.error('ERROR: Set VITE_PROVING_SERVICE_URL environment variable');
    process.exit(1);
  }
  console.log('AVNU API key: configured');
  console.log('Proving service: configured');

  const step = process.argv[2] || 'setup';

  try {
    switch (step) {
      case 'setup':
        await setup();
        break;
      case 'deposit':
        await deposit();
        break;
      case 'transfer':
        await transfer();
        break;
      case 'withdraw':
        await withdraw();
        break;
      case 'all': {
        const { addressA } = await setup();
        console.log('\nWaiting for account to be funded...');
        let balance = 0n;
        for (let i = 0; i < 120; i++) {
          balance = await getStrkBalance(addressA);
          if (balance > 0n) break;
          if (i % 10 === 0) console.log(`  Still waiting... (${i}s)`);
          await sleep(1000);
        }
        assert(balance > 0n, 'Account not funded after 120s');
        console.log(`  Funded: ${formatStrk(balance)}`);

        await deposit();
        await transfer();
        console.log('\n=== ALL TESTS PASSED ===\n');
        break;
      }
      default:
        console.error(`Unknown step: ${step}. Use: setup, deposit, transfer, withdraw, all`);
        process.exit(1);
    }
  } catch (e: any) {
    console.error('\nTEST FAILED:', e.message || e);
    if (e.stack) console.error(e.stack);
    process.exit(1);
  }
}

main();
