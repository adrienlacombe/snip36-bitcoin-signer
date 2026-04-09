/**
 * Submit apply_actions with proof_facts via raw RPC.
 * Full control over hash computation and signing.
 */
import { RpcProvider, hash, selector as sel, CallData, transaction } from 'starknet';
import {
  extractPubKeyCoords, computeStarknetAddress, derivePrivacyKey,
  signStarknetHash, waitForTx, formatStrk,
  PRIVACY_POOL_ADDRESS, STARKNET_RPC_URL,
} from './e2e-helpers';

const PK = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const PROVING_URL = process.env.VITE_PROVING_SERVICE_URL || '';
const toHex = (v: string) => v.startsWith('0x') ? v : '0x' + BigInt(v).toString(16);

async function main() {
  const provider = new RpcProvider({ nodeUrl: STARKNET_RPC_URL });
  const pubKey = extractPubKeyCoords(PK);
  const { address: userAddress } = computeStarknetAddress(pubKey);
  const privacyKey = derivePrivacyKey(PK, userAddress);
  const chainId = await provider.getChainId();
  const userNonce = await provider.getNonceForAddress(userAddress);
  const latestBlock = await provider.getBlockNumber();
  // Must be old enough (>450 blocks from execution) but not too old (node storage limit)
  // Use latest - 460 as a compromise
  const proveBlock = latestBlock - 460;
  const poolNonce = await provider.getNonceForAddress(PRIVACY_POOL_ADDRESS, { blockIdentifier: proveBlock });

  console.log('User:', userAddress, 'nonce:', userNonce);
  console.log('Balance:', formatStrk(await getStrkBalance(userAddress)));
  console.log('Prove block:', proveBlock, 'pool nonce:', poolNonce);

  // Step 1: Compile
  const randomFelt = '0xdeadbeef1234';
  const clientActionArgs = [userAddress, privacyKey, '1', '0', randomFelt];

  const serverActions = await provider.callContract({
    contractAddress: PRIVACY_POOL_ADDRESS,
    entrypoint: 'compile_actions',
    calldata: clientActionArgs,
  });
  console.log('Server actions:', serverActions.length, 'felts');

  // Step 2: Prove (pool is sender)
  const proveInnerCalldata = clientActionArgs.map(toHex);
  const proveCalldata = [
    '0x1', PRIVACY_POOL_ADDRESS,
    sel.getSelectorFromName('compile_actions'),
    '0x' + proveInnerCalldata.length.toString(16),
    ...proveInnerCalldata,
  ];

  const proveRb = {
    l1_gas: { max_amount: 0x0n, max_price_per_unit: 0x0n },
    l2_gas: { max_amount: 0x5F5E100n, max_price_per_unit: 0x0n },
    l1_data_gas: { max_amount: 0x0n, max_price_per_unit: 0x0n },
  };

  const proveTxHash = hash.calculateInvokeTransactionHash({
    senderAddress: PRIVACY_POOL_ADDRESS, version: '0x3',
    compiledCalldata: proveCalldata, chainId, nonce: toHex(poolNonce),
    accountDeploymentData: [], nonceDataAvailabilityMode: 0,
    feeDataAvailabilityMode: 0, paymasterData: [],
    resourceBounds: proveRb, tip: 0n,
  });
  const proveSig = await signStarknetHash(PK, proveTxHash);

  console.log('\nProving...');
  const proveRes = await fetch(PROVING_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'starknet_proveTransaction',
      params: { block_id: { block_number: proveBlock }, transaction: {
        type: 'INVOKE', version: '0x3', sender_address: PRIVACY_POOL_ADDRESS,
        calldata: proveCalldata, signature: proveSig, nonce: toHex(poolNonce),
        resource_bounds: { l1_gas: { max_amount: '0x0', max_price_per_unit: '0x0' }, l2_gas: { max_amount: '0x5F5E100', max_price_per_unit: '0x0' }, l1_data_gas: { max_amount: '0x0', max_price_per_unit: '0x0' } },
        tip: '0x0', paymaster_data: [], account_deployment_data: [],
        nonce_data_availability_mode: 'L1', fee_data_availability_mode: 'L1',
      }}, id: 1,
    }),
  });
  const proveData = await proveRes.json();
  if (proveData.error) throw new Error('Prove failed: ' + JSON.stringify(proveData.error).slice(0, 300));

  const proofFacts: string[] = proveData.result.proof_facts;
  const proof: string = proveData.result.proof;
  console.log('proof_facts:', proofFacts.length, 'elements');
  console.log('proof:', proof.length, 'chars');

  // Step 3: Build on-chain tx (user is sender)
  // Use starknet.js's getExecuteCalldata to match exactly what EthSigner signs
  const applyCalldata = transaction.getExecuteCalldata(
    [{ contractAddress: PRIVACY_POOL_ADDRESS, entrypoint: 'apply_actions', calldata: serverActions }],
    '1', // cairoVersion for EthAccountUpgradeable
  ).map(toHex);

  const onchainRb = {
    l1_gas: { max_amount: 0x200n, max_price_per_unit: 0x400000000000n },
    l2_gas: { max_amount: 0x2000000n, max_price_per_unit: 0x1000000000n },
    l1_data_gas: { max_amount: 0x200n, max_price_per_unit: 0x400000000000n },
  };

  // Compute tx hash WITH proof_facts (node v0.10.2 includes them in hash)
  const onchainTxHash = hash.calculateInvokeTransactionHash({
    senderAddress: userAddress, version: '0x3',
    compiledCalldata: applyCalldata, chainId, nonce: toHex(userNonce),
    accountDeploymentData: [], nonceDataAvailabilityMode: 0,
    feeDataAvailabilityMode: 0, paymasterData: [],
    resourceBounds: onchainRb, tip: 0n,
    proofFacts: proofFacts.map(f => BigInt(f)),
  });
  console.log('\nOn-chain TX hash:', onchainTxHash);

  // Sign
  const onchainSig = await signStarknetHash(PK, onchainTxHash);
  console.log('Signature:', onchainSig);

  // Submit via raw RPC with proof_facts
  console.log('\nSubmitting on-chain...');
  const submitRes = await fetch(STARKNET_RPC_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'starknet_addInvokeTransaction',
      params: { invoke_transaction: {
        type: 'INVOKE', version: '0x3',
        sender_address: userAddress,
        calldata: applyCalldata,
        signature: onchainSig,
        nonce: toHex(userNonce),
        resource_bounds: {
          l1_gas: { max_amount: '0x200', max_price_per_unit: '0x400000000000' },
          l2_gas: { max_amount: '0x2000000', max_price_per_unit: '0x1000000000' },
          l1_data_gas: { max_amount: '0x200', max_price_per_unit: '0x400000000000' },
        },
        tip: '0x0', paymaster_data: [], account_deployment_data: [],
        nonce_data_availability_mode: 'L1', fee_data_availability_mode: 'L1',
        proof_facts: proofFacts,
        proof,
      }}, id: 1,
    }),
  });

  const submitData = await submitRes.json();
  if (submitData.error) {
    console.log('Submit error:', JSON.stringify(submitData.error).slice(0, 500));
    process.exit(1);
  }

  const txHash = submitData.result.transaction_hash;
  console.log('TX:', txHash);
  const status = await waitForTx(txHash);
  console.log('Status:', status);
  console.log(status === 'accepted' ? '\nSETVIEWINGKEY PASSED!' : '\nSETVIEWINGKEY FAILED!');
}

import { getStrkBalance } from './e2e-helpers';
main().catch(e => { console.error('FATAL:', e.message?.slice(0, 500)); process.exit(1); });
