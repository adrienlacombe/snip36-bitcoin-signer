/**
 * Test: Pass compile_actions result as calldata to the pool's __execute__
 * for the proving service.
 *
 * The compile_actions result is server-side actions. The pool's __execute__
 * might directly accept these as its calldata.
 */
import { RpcProvider, hash, CallData, selector as sel } from 'starknet';
import { signStarknetHash, extractPubKeyCoords, computeStarknetAddress, derivePrivacyKey, PRIVACY_POOL_ADDRESS } from './e2e-helpers';

const PK = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const PROVING_URL = process.env.VITE_PROVING_SERVICE_URL || '';

const toHex = (v: string) => v.startsWith('0x') ? v : '0x' + BigInt(v).toString(16);

async function main() {
  const provider = new RpcProvider({ nodeUrl: process.env.VITE_STARKNET_RPC_URL || '' });
  const pubKey = extractPubKeyCoords(PK);
  const { address: userAddress } = computeStarknetAddress(pubKey);
  const privacyKey = derivePrivacyKey(PK, userAddress);
  const chainId = await provider.getChainId();
  const poolNonce = await provider.getNonceForAddress(PRIVACY_POOL_ADDRESS);

  console.log('User:', userAddress);
  console.log('Pool nonce:', poolNonce);

  // Get server actions from compile_actions
  console.log('\nCompiling SetViewingKey...');
  const serverActions = await provider.callContract({
    contractAddress: PRIVACY_POOL_ADDRESS,
    entrypoint: 'compile_actions',
    calldata: [userAddress, privacyKey, '1', '0', '0xdeadbeef1234'],
  });
  console.log('Server actions:', serverActions.length, 'felts');
  console.log('First few:', serverActions.slice(0, 6));

  // Pass server actions directly as pool's __execute__ calldata
  const executeCalldata = serverActions.map(toHex);

  const rb = {
    l1_gas: { max_amount: 0x0n, max_price_per_unit: 0x0n },
    l2_gas: { max_amount: 0x5F5E100n, max_price_per_unit: 0x0n },
    l1_data_gas: { max_amount: 0x0n, max_price_per_unit: 0x0n },
  };

  const txHash = hash.calculateInvokeTransactionHash({
    senderAddress: PRIVACY_POOL_ADDRESS,
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

  const signature = await signStarknetHash(PK, txHash);

  console.log('\nSending to prover...');
  const res = await fetch(PROVING_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'starknet_proveTransaction',
      params: {
        block_id: 'latest',
        transaction: {
          type: 'INVOKE',
          version: '0x3',
          sender_address: PRIVACY_POOL_ADDRESS,
          calldata: executeCalldata,
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
    // Decode any felt error messages
    const errStr = JSON.stringify(data.error, null, 2);
    const feltMatches = errStr.match(/0x[0-9a-fA-F]+/g) || [];
    for (const felt of feltMatches) {
      try {
        if (felt.length > 10 && felt.length < 70) {
          const bytes = Buffer.from(felt.slice(2), 'hex');
          const ascii = bytes.toString('ascii').replace(/[^\x20-\x7E]/g, '');
          if (ascii.length > 3) console.log(`  ${felt} = '${ascii}'`);
        }
      } catch {}
    }
    console.log('\nERROR:', errStr.slice(0, 1000));
  } else {
    console.log('\nSUCCESS!');
    console.log('proof_facts:', data.result?.proof_facts?.length, 'elements');
    console.log('proof length:', data.result?.proof?.length, 'chars');
    console.log('messages:', data.result?.l2_to_l1_messages?.length);
  }
}

main().catch((e) => { console.error('FATAL:', e.message?.slice(0, 500)); process.exit(1); });
