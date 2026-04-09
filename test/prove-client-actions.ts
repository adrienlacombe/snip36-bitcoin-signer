/**
 * Test: Pass client actions as calldata to the pool's __validate__ / __execute__
 *
 * The pool's __validate__ needs to verify the user's signature on the client actions.
 * The pool's __execute__ compiles client actions → server actions and executes them.
 *
 * Calldata format: [user_addr, user_private_key, num_actions, ...action_data]
 * (same as compile_and_panic params, which is the IClient interface)
 */
import { RpcProvider, hash } from 'starknet';
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

  // Build client actions calldata: same params as compile_and_panic
  // compile_and_panic(user_addr, user_private_key, client_actions: Span<ClientAction>)
  // SetViewingKey variant = index 0, field: random
  const clientActionsCalldata = [
    userAddress,       // user_addr
    privacyKey,        // user_private_key
    '1',               // num client actions
    '0',               // ClientAction variant: SetViewingKey
    '0xdeadbeef1234',  // random
  ].map(toHex);

  console.log('Client actions calldata:', clientActionsCalldata.length, 'felts');

  const rb = {
    l1_gas: { max_amount: 0x0n, max_price_per_unit: 0x0n },
    l2_gas: { max_amount: 0x5F5E100n, max_price_per_unit: 0x0n },
    l1_data_gas: { max_amount: 0x0n, max_price_per_unit: 0x0n },
  };

  const txHash = hash.calculateInvokeTransactionHash({
    senderAddress: PRIVACY_POOL_ADDRESS,
    version: '0x3',
    compiledCalldata: clientActionsCalldata,
    chainId,
    nonce: toHex(poolNonce),
    accountDeploymentData: [],
    nonceDataAvailabilityMode: 0,
    feeDataAvailabilityMode: 0,
    paymasterData: [],
    resourceBounds: rb,
    tip: 0n,
  });

  // The pool's __validate__ verifies the USER's signature via is_valid_signature
  // on the user's account contract. The signature should be the user's ETH signature.
  const signature = await signStarknetHash(PK, txHash);

  console.log('\nSending to prover (client actions as calldata)...');
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
          calldata: clientActionsCalldata,
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
    const errStr = JSON.stringify(data.error);
    // Decode felt error messages
    const feltMatches = errStr.match(/0x[0-9a-fA-F]{10,64}/g) || [];
    for (const felt of feltMatches) {
      const bytes = Buffer.from(felt.slice(2), 'hex');
      const ascii = bytes.toString('ascii').replace(/[^\x20-\x7E]/g, '');
      if (ascii.length > 3) console.log(`  ${felt.slice(0,20)}... = '${ascii}'`);
    }
    console.log('\nError code:', data.error.code);
    console.log('Error msg:', data.error.message);
    console.log('Error data:', typeof data.error.data === 'string' ? data.error.data.slice(0, 600) : JSON.stringify(data.error.data).slice(0, 600));
  } else {
    console.log('\nSUCCESS!');
    console.log('proof_facts:', data.result?.proof_facts?.length, 'elements');
    console.log('proof_facts:', data.result?.proof_facts);
    console.log('proof length:', data.result?.proof?.length, 'chars');
    console.log('messages:', data.result?.l2_to_l1_messages?.length);
  }
}

main().catch((e) => { console.error('FATAL:', e.message?.slice(0, 500)); process.exit(1); });
