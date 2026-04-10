/**
 * Full E2E: SetViewingKey → Deposit → Withdraw
 *
 * Flow per action:
 *   1. compile_actions (view) to preview server actions
 *   2. Prove: send invoke tx to prover with sender=POOL, calldata=Call(compile_actions)
 *   3. Get proof + proof_facts from prover
 *   4. Submit on-chain: user's account calls apply_actions with proof + proof_facts
 */
import {
  EthSigner, Account, RpcProvider, hash, selector as sel, CallData,
} from 'starknet';
import {
  extractPubKeyCoords, computeStarknetAddress, derivePrivacyKey,
  signStarknetHash, getStrkBalance, waitForTx, formatStrk,
  PRIVACY_POOL_ADDRESS, STRK_TOKEN_ADDRESS,
} from './e2e-helpers';

const PK = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const RPC_URL = process.env.VITE_STARKNET_RPC_URL || '';
const PROVING_URL = process.env.VITE_PROVING_SERVICE_URL || '';
const AVNU_API_KEY = process.env.VITE_AVNU_API_KEY || '';

const toHex = (v: string) => v.startsWith('0x') ? v : '0x' + BigInt(v).toString(16);

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error('ASSERT FAILED:', msg); process.exit(1); }
}

// ============================================================
// Core: prove an action via the proving service
// ============================================================
async function proveAction(
  provider: RpcProvider,
  userAddress: string,
  privacyKey: string,
  clientActions: string[],  // [num_actions, variant, ...fields]
): Promise<{ proof: string; proofFacts: string[] }> {
  const chainId = await provider.getChainId();

  // The proof must reference a block at least 450 blocks old (get_proof_validity_blocks = 0x1c2)
  const latestBlock = await provider.getBlockNumber();
  const proveBlockNumber = latestBlock - 500;

  // Get the pool nonce at the prove block (it may differ from latest)
  const poolNonce = await provider.getNonceForAddress(PRIVACY_POOL_ADDRESS, { blockIdentifier: proveBlockNumber });
  console.log(`  Prove against block ${proveBlockNumber} (latest: ${latestBlock}), pool nonce: ${poolNonce}`);

  // Build calldata: pool's __execute__ with 1 Call to compile_actions on itself
  const innerCalldata = [userAddress, privacyKey, ...clientActions].map(toHex);
  const calldata = [
    '0x1',
    PRIVACY_POOL_ADDRESS,
    sel.getSelectorFromName('compile_actions'),
    '0x' + innerCalldata.length.toString(16),
    ...innerCalldata,
  ];

  const rb = {
    l1_gas: { max_amount: 0x0n, max_price_per_unit: 0x0n },
    l2_gas: { max_amount: 0x5F5E100n, max_price_per_unit: 0x0n },
    l1_data_gas: { max_amount: 0x0n, max_price_per_unit: 0x0n },
  };

  // Compute tx hash and sign (pool is sender, user signs)
  const txHash = hash.calculateInvokeTransactionHash({
    senderAddress: PRIVACY_POOL_ADDRESS,
    version: '0x3',
    compiledCalldata: calldata,
    chainId,
    nonce: toHex(poolNonce),
    accountDeploymentData: [],
    nonceDataAvailabilityMode: 0,
    feeDataAvailabilityMode: 0,
    paymasterData: [],
    resourceBounds: rb,
    tip: 0n,
  });

  const signature = await signStarknetHash(PK, txHash);

  const res = await fetch(PROVING_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'starknet_proveTransaction',
      params: {
        block_id: { block_number: proveBlockNumber },
        transaction: {
          type: 'INVOKE',
          version: '0x3',
          sender_address: PRIVACY_POOL_ADDRESS,
          calldata,
          signature,
          nonce: toHex(poolNonce),
          resource_bounds: {
            l1_gas: { max_amount: '0x0', max_price_per_unit: '0x0' },
            l2_gas: { max_amount: '0x5F5E100', max_price_per_unit: '0x0' },
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
    }),
  });

  const data = await res.json();
  if (data.error) {
    const errData = String(data.error.data || '');
    throw new Error(`Proving failed: ${data.error.code} ${data.error.message} ${errData.slice(0, 300)}`);
  }

  return {
    proof: data.result.proof,
    proofFacts: data.result.proof_facts,
  };
}

// ============================================================
// Core: submit on-chain with proof + proof_facts
// ============================================================
async function submitWithProof(
  account: Account,
  provider: RpcProvider,
  serverActions: string[],
  proof: string,
  proofFacts: string[],
): Promise<string> {
  const result = await account.execute(
    [{
      contractAddress: PRIVACY_POOL_ADDRESS,
      entrypoint: 'apply_actions',
      calldata: serverActions,
    }],
    {
      proofFacts,
      proof,
      resourceBounds: {
        l1_gas: { max_amount: 0x200n, max_price_per_unit: 0x400000000000n },
        l2_gas: { max_amount: 0x2000000n, max_price_per_unit: 0x1000000000n },
        l1_data_gas: { max_amount: 0x200n, max_price_per_unit: 0x400000000000n },
      },
    },
  );
  return result.transaction_hash;
}

// ============================================================
// Test: SetViewingKey
// ============================================================
async function testSetViewingKey(
  account: Account,
  provider: RpcProvider,
  userAddress: string,
  privacyKey: string,
) {
  console.log('\n=== SetViewingKey ===\n');

  // Check if already set
  try {
    const result = await provider.callContract({
      contractAddress: PRIVACY_POOL_ADDRESS,
      entrypoint: 'get_public_key',
      calldata: [userAddress],
    });
    if (result[0] !== '0x0' && result[0] !== '0') {
      console.log('Already set:', result[0].slice(0, 20) + '...');
      return;
    }
  } catch {}

  const randomBytes = new Uint8Array(31);
  crypto.getRandomValues(randomBytes);
  const random = '0x' + Array.from(randomBytes).map(b => b.toString(16).padStart(2, '0')).join('');

  // Client actions: [num_actions, SetViewingKey variant(0), random]
  const clientActions = ['1', '0', random];

  // Step 1: Prove
  console.log('Proving...');
  const { proof, proofFacts } = await proveAction(provider, userAddress, privacyKey, clientActions);
  console.log(`  proof: ${proof.length} chars, proof_facts: ${proofFacts.length} elements`);

  // Step 2: Get server actions via compile_actions (view)
  console.log('Compiling server actions...');
  const serverActions = await provider.callContract({
    contractAddress: PRIVACY_POOL_ADDRESS,
    entrypoint: 'compile_actions',
    calldata: [userAddress, privacyKey, ...clientActions],
  });
  console.log(`  server actions: ${serverActions.length} felts`);

  // Step 3: Submit on-chain
  console.log('Submitting on-chain with', proofFacts.length, 'proof_facts...');

  // Debug: manually compute hash with and without proofFacts to see which the signer uses
  const debugCalldata = CallData.toCalldata([{
    contractAddress: PRIVACY_POOL_ADDRESS,
    entrypoint: 'apply_actions',
    calldata: serverActions,
  }]);
  const debugChainId = await provider.getChainId();
  const debugNonce = await provider.getNonceForAddress(userAddress);
  const hashWith = hash.calculateInvokeTransactionHash({
    senderAddress: userAddress, version: '0x3',
    compiledCalldata: ['0x1', ...debugCalldata.map(toHex)],
    chainId: debugChainId, nonce: debugNonce,
    accountDeploymentData: [], nonceDataAvailabilityMode: 0,
    feeDataAvailabilityMode: 0, paymasterData: [],
    resourceBounds: { l1_gas: { max_amount: 0x200n, max_price_per_unit: 0x400000000000n }, l2_gas: { max_amount: 0x2000000n, max_price_per_unit: 0x1000000000n }, l1_data_gas: { max_amount: 0x200n, max_price_per_unit: 0x400000000000n } },
    tip: 0n, proofFacts: proofFacts.map(f => BigInt(f)),
  });
  const hashWithout = hash.calculateInvokeTransactionHash({
    senderAddress: userAddress, version: '0x3',
    compiledCalldata: ['0x1', ...debugCalldata.map(toHex)],
    chainId: debugChainId, nonce: debugNonce,
    accountDeploymentData: [], nonceDataAvailabilityMode: 0,
    feeDataAvailabilityMode: 0, paymasterData: [],
    resourceBounds: { l1_gas: { max_amount: 0x200n, max_price_per_unit: 0x400000000000n }, l2_gas: { max_amount: 0x2000000n, max_price_per_unit: 0x1000000000n }, l1_data_gas: { max_amount: 0x200n, max_price_per_unit: 0x400000000000n } },
    tip: 0n,
  });
  console.log('  hash WITH proofFacts:', hashWith);
  console.log('  hash WITHOUT proofFacts:', hashWithout);
  console.log('  hashes differ:', hashWith !== hashWithout);

  try {
    const txHash = await submitWithProof(account, provider, serverActions, proof, proofFacts);
    console.log('  TX:', txHash);
    const status = await waitForTx(txHash);
    assert(status === 'accepted', 'SetViewingKey rejected');
    console.log('SetViewingKey PASSED!');
  } catch (e: any) {
    // Print full error for debugging
    const msg = e.message || '';
    // Find the actual error within the nested message
    const gasMatch = msg.match(/Out of gas/i);
    const sigMatch = msg.match(/invalid signature/i);
    const proofMatch = msg.match(/PROOF|proof/);
    if (gasMatch) console.log('  => Out of gas');
    else if (sigMatch) console.log('  => Invalid signature');
    else if (proofMatch) console.log('  => Proof-related error');

    // Extract the inner-most error
    const innerErrors = msg.match(/0x[0-9a-fA-F]{20,}/g) || [];
    for (const felt of innerErrors.slice(-3)) {
      const bytes = Buffer.from(felt.slice(2).padStart(felt.length % 2 === 0 ? felt.length - 2 : felt.length - 1, '0'), 'hex');
      const ascii = bytes.toString('ascii').replace(/[^\x20-\x7E]/g, '');
      if (ascii.length > 3) console.log(`  Felt decode: '${ascii}'`);
    }
    throw e;
  }
}

// ============================================================
// Test: Deposit
// ============================================================
async function testDeposit(
  account: Account,
  provider: RpcProvider,
  userAddress: string,
  privacyKey: string,
) {
  console.log('\n=== Deposit ===\n');

  const depositAmount = '1000000000000000'; // 0.001 STRK

  // Step 0: Approve STRK
  console.log('Approving STRK...');
  const approveResult = await account.execute(
    [{
      contractAddress: STRK_TOKEN_ADDRESS,
      entrypoint: 'approve',
      calldata: [PRIVACY_POOL_ADDRESS, depositAmount, '0'],
    }],
    {
      resourceBounds: {
        l1_gas: { max_amount: 0x400n, max_price_per_unit: 0x400000000000n },
        l2_gas: { max_amount: 0xE000000n, max_price_per_unit: 0x4000000000n },
        l1_data_gas: { max_amount: 0x400n, max_price_per_unit: 0x20000n },
      },
    },
  );
  console.log('  Approve TX:', approveResult.transaction_hash);
  await waitForTx(approveResult.transaction_hash);

  // Client actions: [num_actions, Deposit variant(5), token, amount]
  const clientActions = ['1', '5', STRK_TOKEN_ADDRESS, depositAmount];

  // Step 1: Prove
  console.log('Proving deposit...');
  const { proof, proofFacts } = await proveAction(provider, userAddress, privacyKey, clientActions);
  console.log(`  proof: ${proof.length} chars, proof_facts: ${proofFacts.length} elements`);

  // Step 2: Get server actions
  console.log('Compiling server actions...');
  const serverActions = await provider.callContract({
    contractAddress: PRIVACY_POOL_ADDRESS,
    entrypoint: 'compile_actions',
    calldata: [userAddress, privacyKey, ...clientActions],
  });
  console.log(`  server actions: ${serverActions.length} felts`);

  // Step 3: Submit
  console.log('Submitting deposit on-chain...');
  const txHash = await submitWithProof(account, provider, serverActions, proof, proofFacts);
  console.log('  TX:', txHash);
  const status = await waitForTx(txHash);
  assert(status === 'accepted', 'Deposit rejected');
  console.log('Deposit PASSED!');
}

// ============================================================
// Test: Withdraw
// ============================================================
async function testWithdraw(
  account: Account,
  provider: RpcProvider,
  userAddress: string,
  privacyKey: string,
) {
  console.log('\n=== Withdraw ===\n');

  const withdrawAmount = '500000000000000'; // 0.0005 STRK
  const randomBytes = new Uint8Array(31);
  crypto.getRandomValues(randomBytes);
  const random = '0x' + Array.from(randomBytes).map(b => b.toString(16).padStart(2, '0')).join('');

  // Client actions: [num_actions, Withdraw variant(7), to_addr, token, amount, random]
  const clientActions = ['1', '7', userAddress, STRK_TOKEN_ADDRESS, withdrawAmount, random];

  // Step 1: Prove
  console.log('Proving withdraw...');
  const { proof, proofFacts } = await proveAction(provider, userAddress, privacyKey, clientActions);
  console.log(`  proof: ${proof.length} chars, proof_facts: ${proofFacts.length} elements`);

  // Step 2: Get server actions
  console.log('Compiling server actions...');
  const serverActions = await provider.callContract({
    contractAddress: PRIVACY_POOL_ADDRESS,
    entrypoint: 'compile_actions',
    calldata: [userAddress, privacyKey, ...clientActions],
  });
  console.log(`  server actions: ${serverActions.length} felts`);

  // Step 3: Submit
  console.log('Submitting withdraw on-chain...');
  const txHash = await submitWithProof(account, provider, serverActions, proof, proofFacts);
  console.log('  TX:', txHash);
  const status = await waitForTx(txHash);
  assert(status === 'accepted', 'Withdraw rejected');
  console.log('Withdraw PASSED!');
}

// ============================================================
// Main
// ============================================================
async function main() {
  console.log('SNIP-36 — Full E2E Test');
  console.log('===========================\n');

  const provider = new RpcProvider({ nodeUrl: RPC_URL });
  const pubKey = extractPubKeyCoords(PK);
  const { address: userAddress } = computeStarknetAddress(pubKey);
  const privacyKey = derivePrivacyKey(PK, userAddress);

  const signer = new EthSigner('0x' + PK);
  const account = new Account({ provider, address: userAddress, signer });

  console.log('User:', userAddress);
  console.log('Balance:', formatStrk(await getStrkBalance(userAddress)));

  const step = process.argv[2] || 'all';

  if (step === 'viewkey' || step === 'all') {
    await testSetViewingKey(account, provider, userAddress, privacyKey);
  }
  if (step === 'deposit' || step === 'all') {
    await testDeposit(account, provider, userAddress, privacyKey);
  }
  if (step === 'withdraw' || step === 'all') {
    await testWithdraw(account, provider, userAddress, privacyKey);
  }

  console.log('\n=== ALL TESTS PASSED ===');
  console.log('Balance after:', formatStrk(await getStrkBalance(userAddress)));
}

main().catch((e) => {
  // Extract just the error reason, not the full RPC params dump
  const msg = e.message || String(e);
  const reasonMatch = msg.match(/Account validation failed[^"]*"([^"]*)"/);
  const revertMatch = msg.match(/'([A-Z_]+)'/);
  const codeMatch = msg.match(/(\d+): /);
  if (reasonMatch) {
    console.error('\nTEST FAILED: Validation error:', reasonMatch[1].slice(0, 300));
  } else if (revertMatch) {
    console.error('\nTEST FAILED:', revertMatch[1]);
  } else if (codeMatch) {
    console.error('\nTEST FAILED (code ' + codeMatch[1] + '):', msg.slice(msg.indexOf(codeMatch[1]), msg.indexOf(codeMatch[1]) + 200));
  } else {
    console.error('\nTEST FAILED:', msg.slice(0, 300));
  }
  process.exit(1);
});
