/**
 * Test: Send compile_and_panic to the proving service.
 *
 * Per the paper (Section 7): the ZK-proof compiles client-side actions
 * into server-side actions. compile_and_panic is the external function
 * that does this in the virtual block — it panics with the output.
 */
import { RpcProvider, hash, CallData, selector as sel, EthSigner } from 'starknet';
import { signStarknetHash, extractPubKeyCoords, computeStarknetAddress, derivePrivacyKey, PRIVACY_POOL_ADDRESS } from './e2e-helpers';

const PK = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const PROVING_URL = process.env.VITE_PROVING_SERVICE_URL || '';

async function main() {
  const provider = new RpcProvider({ nodeUrl: process.env.VITE_STARKNET_RPC_URL || '' });
  const pubKey = extractPubKeyCoords(PK);
  const { address } = computeStarknetAddress(pubKey);
  const privacyKey = derivePrivacyKey(PK, address);
  const nonce = await provider.getNonceForAddress(address);
  const chainId = await provider.getChainId();

  console.log('Account:', address);
  console.log('Privacy key:', privacyKey);
  console.log('Nonce:', nonce);

  const toHex = (v: string) => v.startsWith('0x') ? v : '0x' + BigInt(v).toString(16);

  // Build calldata: user's __execute__ calls compile_and_panic on the privacy pool
  // compile_and_panic(user_addr, user_private_key, client_actions)
  // For SetViewingKey: client_actions = [SetViewingKey(random)]
  const compileAndPanicCalldata = CallData.toCalldata([{
    contractAddress: PRIVACY_POOL_ADDRESS,
    entrypoint: 'compile_and_panic',
    calldata: [address, privacyKey, '1', '0', '0xdeadbeef1234'],
  }]);

  const executeCalldata = ['0x1', ...compileAndPanicCalldata.map(toHex)];
  console.log('Execute calldata:', executeCalldata.length, 'felts');

  // Resource bounds for proving: all prices = 0
  const rb = {
    l1_gas: { max_amount: 0x0n, max_price_per_unit: 0x0n },
    l2_gas: { max_amount: 0x5F5E100n, max_price_per_unit: 0x0n },
    l1_data_gas: { max_amount: 0x0n, max_price_per_unit: 0x0n },
  };

  // Compute tx hash and sign
  const txHash = hash.calculateInvokeTransactionHash({
    senderAddress: address,
    version: '0x3',
    compiledCalldata: executeCalldata,
    chainId,
    nonce: toHex(nonce),
    accountDeploymentData: [],
    nonceDataAvailabilityMode: 0,
    feeDataAvailabilityMode: 0,
    paymasterData: [],
    resourceBounds: rb,
    tip: 0n,
  });
  console.log('TX hash:', txHash);

  const signature = await signStarknetHash(PK, txHash);
  console.log('Signature:', signature);

  // Send to proving service
  console.log('\nSending compile_and_panic to prover...');
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
          sender_address: address,
          calldata: executeCalldata,
          signature,
          nonce: toHex(nonce),
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
    console.log('ERROR:', JSON.stringify(data.error, null, 2).slice(0, 1000));
  } else {
    console.log('SUCCESS!');
    console.log('Result keys:', Object.keys(data.result || {}));
    console.log('Result:', JSON.stringify(data.result).slice(0, 1000));
  }
}

main().catch((e) => { console.error('FATAL:', e.message?.slice(0, 500)); process.exit(1); });
