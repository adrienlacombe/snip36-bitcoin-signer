/**
 * Prove and execute a privacy pool action.
 * Flow: compile_actions -> prove -> sign with proof_facts -> submit
 */
import {
  extractPubKeyCoords,
  computeStarknetAddress,
  getProvider,
  getStrkBalance,
  waitForTx,
  derivePrivacyKey,
  formatStrk,
  signStarknetHash,
  PRIVACY_POOL_ADDRESS,
  STRK_TOKEN_ADDRESS,
  STARKNET_RPC_URL,
  AVNU_API_KEY,
} from './e2e-helpers';
import { EthSigner, Account, RpcProvider, CallData, selector as selectorUtil } from 'starknet';

const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const PROVING_SERVICE_URL = process.env.VITE_PROVING_SERVICE_URL || '';

async function main() {
  console.log('=== Prove & Execute Test ===\n');

  const pubKey = extractPubKeyCoords(TEST_PRIVATE_KEY.slice(2));
  const { address } = computeStarknetAddress(pubKey);
  console.log('Account:', address);

  const provider = getProvider();
  const balance = await getStrkBalance(address);
  console.log('Balance:', formatStrk(balance));

  const privacyKey = derivePrivacyKey(TEST_PRIVATE_KEY.slice(2), address);
  console.log('Privacy key:', privacyKey);

  // Get nonce
  const nonce = await provider.getNonceForAddress(address);
  console.log('Nonce:', nonce);

  // Step 1: Check if viewing key is set, compile SetViewingKey if needed
  let needsViewingKey = true;
  try {
    const pubKeyResult = await provider.callContract({
      contractAddress: PRIVACY_POOL_ADDRESS,
      entrypoint: 'get_public_key',
      calldata: [address],
    });
    if (pubKeyResult[0] !== '0x0' && pubKeyResult[0] !== '0') {
      needsViewingKey = false;
      console.log('Viewing key already set');
    }
  } catch {}

  // Build client action
  const randomBytes = new Uint8Array(31);
  crypto.getRandomValues(randomBytes);
  const randomFelt = '0x' + Array.from(randomBytes).map((b) => b.toString(16).padStart(2, '0')).join('');

  let actionName: string;
  let actionCalldata: string[];

  if (needsViewingKey) {
    actionName = 'SetViewingKey';
    actionCalldata = [address, privacyKey, '1', '0', randomFelt];
  } else {
    actionName = 'Deposit';
    // First approve STRK
    console.log('\nApproving STRK...');
    const signer = new EthSigner(TEST_PRIVATE_KEY);
    const account = new Account({ provider, address, signer });
    const approveResult = await account.execute(
      [{
        contractAddress: STRK_TOKEN_ADDRESS,
        entrypoint: 'approve',
        calldata: [PRIVACY_POOL_ADDRESS, '1000000000000000', '0'],
      }],
      {
        resourceBounds: {
          l1_gas: { max_amount: 0x400n, max_price_per_unit: 0x400000000000n },
          l2_gas: { max_amount: 0xE000000n, max_price_per_unit: 0x4000000000n },
          l1_data_gas: { max_amount: 0x400n, max_price_per_unit: 0x20000n },
        },
      },
    );
    console.log('Approve TX:', approveResult.transaction_hash);
    await waitForTx(approveResult.transaction_hash);

    actionCalldata = [address, privacyKey, '1', '5', STRK_TOKEN_ADDRESS, '1000000000000000'];
  }

  // Step 2: compile_actions
  console.log(`\nCompiling ${actionName}...`);
  const compileResult = await provider.callContract({
    contractAddress: PRIVACY_POOL_ADDRESS,
    entrypoint: 'compile_actions',
    calldata: actionCalldata,
  });
  console.log('Server actions:', compileResult.length, 'felts');

  // Step 3: Build the __execute__ calldata (all hex-prefixed)
  const toHex = (v: string) => v.startsWith('0x') ? v : '0x' + BigInt(v).toString(16);
  const executeCalldata = [
    '0x1',  // num calls
    PRIVACY_POOL_ADDRESS,
    selectorUtil.getSelectorFromName('apply_actions'),
    '0x' + compileResult.length.toString(16),
    ...compileResult.map(toHex),
  ];

  // Get fresh nonce (may have changed if we did approve)
  const freshNonce = await provider.getNonceForAddress(address);
  const nonceHex = freshNonce.startsWith('0x') ? freshNonce : '0x' + BigInt(freshNonce).toString(16);
  console.log('Fresh nonce:', nonceHex);

  // Step 4: Sign the transaction WITHOUT proof_facts for the proving service
  // The proving service executes in a virtual block and validates the signature
  const signer = new EthSigner(TEST_PRIVATE_KEY);
  const account = new Account({ provider, address, signer });

  // Use zero-cost resource bounds for proving (prover requirement)
  const proveResourceBounds = {
    l1_gas: { max_amount: 0x0n, max_price_per_unit: 0x0n },
    l2_gas: { max_amount: 0x5F5E100n, max_price_per_unit: 0x0n },
    l1_data_gas: { max_amount: 0x0n, max_price_per_unit: 0x0n },
  };

  // Build the invoke details for signing
  const calls = [{
    contractAddress: PRIVACY_POOL_ADDRESS,
    entrypoint: 'apply_actions',
    calldata: compileResult,
  }];

  // Sign transaction for proving (no proof_facts)
  console.log('\nSigning for proving service...');
  const chainId = await provider.getChainId();
  const signerPubKey = await signer.getPubKey();

  // Use account.buildInvocation to get the signed transaction
  // But we need to set the resource bounds to zero for proving
  // Let's manually build the transaction and sign it
  const { hash: hashModule, selector: selectorModule } = await import('starknet');

  // Build calldata the same way Account does: [num_calls, ...toCalldata(calls)]
  const rawCalldata = CallData.toCalldata(calls);
  const compiledCalldata = [calls.length.toString(), ...rawCalldata];

  const txHash = hashModule.calculateInvokeTransactionHash({
    senderAddress: address,
    version: '0x3',
    compiledCalldata,
    chainId,
    nonce: nonceHex,
    accountDeploymentData: [],
    nonceDataAvailabilityMode: 0,
    feeDataAvailabilityMode: 0,
    paymasterData: [],
    resourceBounds: proveResourceBounds,
    tip: 0n,
  });
  console.log('TX hash (for prover):', txHash);

  // Sign the tx hash directly with secp256k1 (raw, no prefix)
  const signature = await signStarknetHash(TEST_PRIVATE_KEY.slice(2), txHash);
  console.log('Signature:', signature);

  // Step 5: Call proving service with signed transaction
  console.log('\nCalling proving service...');
  const proveTx = {
    type: 'INVOKE',
    version: '0x3',
    sender_address: address,
    calldata: compiledCalldata.map(toHex),
    signature: [...signature],
    nonce: nonceHex,
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
  };

  const proveResponse = await fetch(PROVING_SERVICE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'starknet_proveTransaction',
      params: { block_id: 'latest', transaction: proveTx },
      id: 1,
    }),
  });

  const proveResult = await proveResponse.json();
  if (proveResult.error) {
    console.error('Proving error:', JSON.stringify(proveResult.error, null, 2));
    process.exit(1);
  }

  console.log('Proof result keys:', Object.keys(proveResult.result || {}));
  console.log('Proof result preview:', JSON.stringify(proveResult.result).slice(0, 500));

  // Step 6: Extract proof_facts and proof from result
  const proofFacts = proveResult.result?.proof_facts || proveResult.result?.proofFacts || [];
  const proof = proveResult.result?.proof || '';
  console.log('proof_facts:', proofFacts.length, 'elements');
  console.log('proof length:', proof.length, 'chars');

  // Step 7: Execute on-chain WITH proof_facts (re-sign with proof_facts in hash)
  console.log('\nExecuting on-chain with proof_facts...');
  const result = await account.execute(calls, {
    nonce: nonceHex,
    proofFacts,
    proof,
    resourceBounds: {
      l1_gas: { max_amount: 0x400n, max_price_per_unit: 0x400000000000n },
      l2_gas: { max_amount: 0xE000000n, max_price_per_unit: 0x4000000000n },
      l1_data_gas: { max_amount: 0x400n, max_price_per_unit: 0x20000n },
    },
  });

  console.log('TX:', result.transaction_hash);
  const status = await waitForTx(result.transaction_hash);
  console.log('Status:', status);

  if (status === 'accepted') {
    console.log(`\n${actionName} PASSED!`);
  } else {
    console.log(`\n${actionName} FAILED!`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('FAILED:', e.message || e);
  process.exit(1);
});
