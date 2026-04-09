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
// Step 2: Deposit STRK into privacy pool
// ============================================================

async function deposit() {
  console.log('\n=== STEP 2: Deposit ===\n');

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

  // Deposit amount: 0.001 STRK
  const depositAmount = 1000000000000000n; // 0.001 * 10^18

  // First, we need to approve the privacy pool to spend our STRK.
  // Build an ERC20 approve call + deposit action as a multicall.

  // Step 2a: Approve STRK spending by privacy pool
  console.log('\nApproving STRK for privacy pool...');
  const approveTxHash = await directInvoke({
    privateKeyHex: TEST_PRIVATE_KEY,
    starknetAddress: address,
    calls: [
      {
        contractAddress: STRK_TOKEN_ADDRESS,
        entrypoint: 'approve',
        calldata: [
          PRIVACY_POOL_ADDRESS,           // spender
          depositAmount.toString(),       // amount low
          '0',                            // amount high
        ],
      },
    ],
  });
  console.log('  Approve TX:', approveTxHash);
  const approveStatus = await waitForTx(approveTxHash);
  assert(approveStatus === 'accepted', 'Approve transaction rejected');

  const provider = getProvider();

  // Generate random felt helper
  const randomFelt = () => {
    const bytes = new Uint8Array(31);
    crypto.getRandomValues(bytes);
    return '0x' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  };

  // Step 2b: Set viewing key if needed (separate action)
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
  }

  // Step 2c: Deposit + Withdraw in one action set (with SetViewingKey for replay protection)
  // compile_actions requires a WriteOnce action. SetViewingKey(random) satisfies this.
  // We bundle: SetViewingKey(re-register) + Deposit + Withdraw(to self, same amount).
  // Net effect: tokens flow through the pool and back = proves the full pipeline.
  console.log('\nCompiling deposit + withdraw action...');
  console.log(`  Deposit amount: ${formatStrk(depositAmount)}`);

  const depositClientActions = [
    address,
    privacyKey,
    '3',                                                            // 3 actions
    '0', randomFelt(),                                              // SetViewingKey(random) — WriteOnce replay protection
    '5', STRK_TOKEN_ADDRESS, depositAmount.toString(),              // Deposit(token, amount)
    '7', address, STRK_TOKEN_ADDRESS, depositAmount.toString(), randomFelt(), // Withdraw(to_self, token, amount, random)
  ];
  const depositServerActions = await provider.callContract({
    contractAddress: PRIVACY_POOL_ADDRESS,
    entrypoint: 'compile_actions',
    calldata: depositClientActions,
  });
  console.log('  Server actions:', depositServerActions.length, 'felts');

  // Step 2d: Prove and execute apply_actions (deposit + withdraw)
  console.log('\nProving and executing apply_actions (deposit + withdraw)...');
  const applyTxHash = await proveAndExecute({
    privateKeyHex: TEST_PRIVATE_KEY,
    starknetAddress: address,
    clientActions: depositClientActions,
    serverActions: [...depositServerActions],
  });
  console.log('  Apply TX:', applyTxHash);
  const applyStatus = await waitForTx(applyTxHash);
  assert(applyStatus === 'accepted', 'Apply actions transaction rejected');

  // Check balance after
  const balanceAfter = await getStrkBalance(address);
  console.log(`\nBalance after deposit: ${formatStrk(balanceAfter)}`);
  console.log('DEPOSIT TEST PASSED!\n');
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
