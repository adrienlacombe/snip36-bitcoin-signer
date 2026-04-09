/**
 * Test: Use AVNU paymaster's new apply_action transaction type for privacy pool.
 * Per avnu-labs/paymaster#67:
 *   1. buildTransaction({ type: "apply_action", apply_action: { pool_address } })
 *   2. Prove via proving service
 *   3. executeTransaction({ type: "apply_action", apply_action: { call, proof, proof_facts } })
 */
import { RpcProvider, hash, selector as sel } from 'starknet';
import {
  extractPubKeyCoords, computeStarknetAddress, derivePrivacyKey,
  signStarknetHash, waitForTx, formatStrk, getStrkBalance,
  PRIVACY_POOL_ADDRESS, AVNU_PAYMASTER_URL, STARKNET_RPC_URL,
} from './e2e-helpers';

const PK = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const PROVING_URL = process.env.VITE_PROVING_SERVICE_URL || '';
const AVNU_API_KEY = process.env.VITE_AVNU_API_KEY || '';
const toHex = (v: string) => v.startsWith('0x') ? v : '0x' + BigInt(v).toString(16);

async function main() {
  const provider = new RpcProvider({ nodeUrl: STARKNET_RPC_URL });
  const pubKey = extractPubKeyCoords(PK);
  const { address: userAddress } = computeStarknetAddress(pubKey);
  const privacyKey = derivePrivacyKey(PK, userAddress);

  console.log('User:', userAddress);
  console.log('Balance:', formatStrk(await getStrkBalance(userAddress)));

  // Step 1: buildTransaction with apply_action type
  console.log('\n1. Building transaction via AVNU (apply_action)...');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (AVNU_API_KEY) headers['x-paymaster-api-key'] = AVNU_API_KEY;

  const buildRes = await fetch(AVNU_PAYMASTER_URL, {
    method: 'POST', headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'paymaster_buildTransaction',
      params: {
        transaction: {
          type: 'apply_action',
          apply_action: { pool_address: PRIVACY_POOL_ADDRESS },
        },
        parameters: {
          version: '0x1',
          fee_mode: { mode: 'sponsored' },
        },
      },
      id: 1,
    }),
  });

  const buildData = await buildRes.json();
  if (buildData.error) {
    console.log('Build error:', JSON.stringify(buildData.error, null, 2).slice(0, 500));
    process.exit(1);
  }

  console.log('Build result keys:', Object.keys(buildData.result || {}));
  console.log('Build result:', JSON.stringify(buildData.result).slice(0, 500));

  const feeAction = buildData.result?.fee_action;
  console.log('Fee action:', feeAction);

  // Step 2: Compile + Prove
  // Build client actions: SetViewingKey + fee withdraw (if fee > 0)
  const randomFelt = '0xdeadbeef1234';
  let clientActionArgs: string[];

  // For SetViewingKey, skip fee withdraw — user has no private balance yet
  // Fee withdraw is only needed for actions that move funds (deposit/withdraw/transfer)
  clientActionArgs = [userAddress, privacyKey, '1', '0', randomFelt];

  // Compile (view call)
  console.log('\n2. Compiling actions...');
  const serverActions = await provider.callContract({
    contractAddress: PRIVACY_POOL_ADDRESS,
    entrypoint: 'compile_actions',
    calldata: clientActionArgs,
  });
  console.log('Server actions:', serverActions.length, 'felts');

  // Prove
  console.log('\n3. Proving...');
  const latestBlock = await provider.getBlockNumber();
  const proveBlock = latestBlock - 460;
  const poolNonce = await provider.getNonceForAddress(PRIVACY_POOL_ADDRESS, { blockIdentifier: proveBlock });

  const proveInnerCalldata = clientActionArgs.map(toHex);
  const proveCalldata = [
    '0x1', PRIVACY_POOL_ADDRESS,
    sel.getSelectorFromName('compile_actions'),
    '0x' + proveInnerCalldata.length.toString(16),
    ...proveInnerCalldata,
  ];

  const chainId = await provider.getChainId();
  const proveTxHash = hash.calculateInvokeTransactionHash({
    senderAddress: PRIVACY_POOL_ADDRESS, version: '0x3',
    compiledCalldata: proveCalldata, chainId, nonce: toHex(poolNonce),
    accountDeploymentData: [], nonceDataAvailabilityMode: 0,
    feeDataAvailabilityMode: 0, paymasterData: [],
    resourceBounds: { l1_gas: { max_amount: 0x0n, max_price_per_unit: 0x0n }, l2_gas: { max_amount: 0x5F5E100n, max_price_per_unit: 0x0n }, l1_data_gas: { max_amount: 0x0n, max_price_per_unit: 0x0n } },
    tip: 0n,
  });
  const proveSig = await signStarknetHash(PK, proveTxHash);

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
  if (proveData.error) {
    console.log('Prove error:', JSON.stringify(proveData.error).slice(0, 500));
    process.exit(1);
  }

  const { proof, proof_facts } = proveData.result;
  console.log('proof:', proof.length, 'chars, proof_facts:', proof_facts.length, 'elements');

  // Step 3: executeTransaction via AVNU
  console.log('\n4. Executing via AVNU paymaster...');

  // Build the apply_actions call from server actions
  const applyCall = {
    to: PRIVACY_POOL_ADDRESS,
    selector: sel.getSelectorFromName('apply_actions'),
    calldata: serverActions.map(toHex),
  };

  const execRes = await fetch(AVNU_PAYMASTER_URL, {
    method: 'POST', headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'paymaster_executeTransaction',
      params: {
        transaction: {
          type: 'apply_action',
          apply_action: {
            apply_actions_call: applyCall,
            proof,
            proof_facts,
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

  const execData = await execRes.json();
  if (execData.error) {
    console.log('Execute error:', JSON.stringify(execData.error, null, 2).slice(0, 500));
    process.exit(1);
  }

  const txHash = execData.result?.transaction_hash;
  console.log('TX:', txHash);

  if (txHash) {
    const status = await waitForTx(txHash);
    console.log('Status:', status);
    console.log(status === 'accepted' ? '\nSETVIEWINGKEY PASSED!' : '\nFAILED');
  }
}

main().catch(e => { console.error('FATAL:', e.message?.slice(0, 500)); process.exit(1); });
