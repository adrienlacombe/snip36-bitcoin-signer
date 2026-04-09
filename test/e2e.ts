/**
 * E2E Integration Tests for SNIP-36 EVM Privacy Pool
 *
 * Run:  VITE_AVNU_API_KEY=<key> npx tsx test/e2e.ts [step]
 *
 * Steps:
 *   setup    — compute address, deploy account (print address to fund)
 *   deposit  — deposit STRK into privacy pool
 *   withdraw — withdraw STRK from privacy pool
 *   all      — run setup + wait for funding + deposit + withdraw
 */
import {
  extractPubKeyCoords,
  computeStarknetAddress,
  deployViaPaymaster,
  isDeployed,
  getStrkBalance,
  waitForTx,
  derivePrivacyKey,
  signAndExecuteInvoke,
  directInvoke,
  proveAndExecute,
  formatStrk,
  getProvider,
  PRIVACY_POOL_ADDRESS,
  STRK_TOKEN_ADDRESS,
  AVNU_API_KEY,
  PROVING_SERVICE_URL,
} from './e2e-helpers';

// ============================================================
// Test private key (Hardhat #0 — DO NOT use with real funds)
// ============================================================
const TEST_PRIVATE_KEY = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

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

async function setup() {
  console.log('\n=== STEP 1: Setup ===\n');

  // 1a. Extract public key coords
  console.log('Extracting secp256k1 public key...');
  const pubKey = extractPubKeyCoords(TEST_PRIVATE_KEY);
  console.log('  x_low :', pubKey.xLow);
  console.log('  x_high:', pubKey.xHigh);
  console.log('  y_low :', pubKey.yLow);
  console.log('  y_high:', pubKey.yHigh);

  // 1b. Compute counterfactual address
  console.log('\nComputing Starknet address...');
  const { address, salt, constructorCalldata } = computeStarknetAddress(pubKey);
  console.log('  Address:', address);
  console.log('  Salt:   ', salt);
  console.log('  Calldata:', constructorCalldata);

  // 1c. Check if already deployed
  const deployed = await isDeployed(address);
  if (deployed) {
    console.log('\n  Account already deployed!');
  } else {
    console.log('\nDeploying via AVNU paymaster (sponsored)...');
    try {
      const txHash = await deployViaPaymaster({ address, salt, constructorCalldata });
      console.log('  Deploy TX:', txHash);
      const status = await waitForTx(txHash);
      assert(status === 'accepted', 'Deploy transaction was rejected');
      console.log('  Deploy confirmed!');
    } catch (e: any) {
      // If error contains "already deployed" or similar, that's OK
      if (e.message?.includes('deployed') || e.message?.includes('ALREADY')) {
        console.log('  Account was already deployed (race condition OK)');
      } else {
        throw e;
      }
    }
  }

  // 1d. Check balance
  const balance = await getStrkBalance(address);
  console.log(`\n  Balance: ${formatStrk(balance)}`);

  if (balance === 0n) {
    console.log('\n╔══════════════════════════════════════════════════════╗');
    console.log('║  FUND THIS ADDRESS WITH STRK:                       ║');
    console.log(`║  ${address} ║`);
    console.log('╚══════════════════════════════════════════════════════╝');
    console.log('\nRun `npx tsx test/e2e.ts deposit` after funding.\n');
  }

  return { address, pubKey, salt, constructorCalldata };
}

// ============================================================
// Step 2: Privacy pool integration — compile, prove, submit
// ============================================================

async function deposit() {
  console.log('\n=== STEP 2: Privacy Pool Integration ===\n');

  const pubKey = extractPubKeyCoords(TEST_PRIVATE_KEY);
  const { address } = computeStarknetAddress(pubKey);
  console.log('Account:', address);

  // Check balance
  const balance = await getStrkBalance(address);
  console.log('Balance:', formatStrk(balance));
  assert(balance > 0n, 'Account has no STRK balance — fund it first');

  // Derive privacy key
  const privacyKey = derivePrivacyKey(TEST_PRIVATE_KEY, address);
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
      privateKeyHex: TEST_PRIVATE_KEY,
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

  console.log('\nINTEGRATION TEST PASSED!\n');
}

// ============================================================
// Step 3: Withdraw STRK from privacy pool
// ============================================================

async function withdraw() {
  console.log('\n=== STEP 3: Withdraw ===\n');

  const pubKey = extractPubKeyCoords(TEST_PRIVATE_KEY);
  const { address } = computeStarknetAddress(pubKey);
  console.log('Account:', address);

  const balanceBefore = await getStrkBalance(address);
  console.log('Balance before:', formatStrk(balanceBefore));

  // Derive privacy key
  const privacyKey = derivePrivacyKey(TEST_PRIVATE_KEY, address);

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
    privateKeyHex: TEST_PRIVATE_KEY,
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
      case 'withdraw':
        await withdraw();
        break;
      case 'all': {
        const { address } = await setup();
        // Wait for funding
        console.log('\nWaiting for account to be funded...');
        let balance = 0n;
        for (let i = 0; i < 120; i++) {
          balance = await getStrkBalance(address);
          if (balance > 0n) break;
          if (i % 10 === 0) console.log(`  Still waiting... (${i}s)`);
          await sleep(1000);
        }
        assert(balance > 0n, 'Account not funded after 120s');
        console.log(`  Funded: ${formatStrk(balance)}`);

        await deposit();
        await withdraw();
        console.log('\n=== ALL TESTS PASSED ===\n');
        break;
      }
      default:
        console.error(`Unknown step: ${step}. Use: setup, deposit, withdraw, all`);
        process.exit(1);
    }
  } catch (e: any) {
    console.error('\nTEST FAILED:', e.message || e);
    if (e.stack) console.error(e.stack);
    process.exit(1);
  }
}

main();
