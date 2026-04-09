import { RpcProvider, hash, selector as sel } from 'starknet';
import { signStarknetHash, extractPubKeyCoords, computeStarknetAddress, derivePrivacyKey, PRIVACY_POOL_ADDRESS } from './e2e-helpers';

const PK = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const toHex = (v: string) => v.startsWith('0x') ? v : '0x' + BigInt(v).toString(16);

async function trySelector(selectorName: string, innerCalldata: string[]) {
  const provider = new RpcProvider({ nodeUrl: process.env.VITE_STARKNET_RPC_URL || '' });
  const pubKey = extractPubKeyCoords(PK);
  const { address } = computeStarknetAddress(pubKey);
  const privacyKey = derivePrivacyKey(PK, address);
  const chainId = await provider.getChainId();
  const poolNonce = await provider.getNonceForAddress(PRIVACY_POOL_ADDRESS);

  // One Call: [1, to, selector, calldata_len, ...calldata]
  const calldata = [
    '0x1',
    PRIVACY_POOL_ADDRESS,
    sel.getSelectorFromName(selectorName),
    '0x' + innerCalldata.length.toString(16),
    ...innerCalldata,
  ];

  const rb = {
    l1_gas: { max_amount: 0x0n, max_price_per_unit: 0x0n },
    l2_gas: { max_amount: 0x5F5E100n, max_price_per_unit: 0x0n },
    l1_data_gas: { max_amount: 0x0n, max_price_per_unit: 0x0n },
  };

  const txHash = hash.calculateInvokeTransactionHash({
    senderAddress: PRIVACY_POOL_ADDRESS, version: '0x3', compiledCalldata: calldata,
    chainId, nonce: toHex(poolNonce), accountDeploymentData: [],
    nonceDataAvailabilityMode: 0, feeDataAvailabilityMode: 0,
    paymasterData: [], resourceBounds: rb, tip: 0n,
  });

  const signature = await signStarknetHash(PK, txHash);

  const res = await fetch(process.env.VITE_PROVING_SERVICE_URL || '', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'starknet_proveTransaction',
      params: { block_id: 'latest', transaction: {
        type: 'INVOKE', version: '0x3', sender_address: PRIVACY_POOL_ADDRESS,
        calldata, signature, nonce: toHex(poolNonce),
        resource_bounds: { l1_gas: { max_amount: '0x0', max_price_per_unit: '0x0' }, l2_gas: { max_amount: '0x5F5E100', max_price_per_unit: '0x0' }, l1_data_gas: { max_amount: '0x0', max_price_per_unit: '0x0' } },
        tip: '0x0', paymaster_data: [], account_deployment_data: [],
        nonce_data_availability_mode: 'L1', fee_data_availability_mode: 'L1',
      }}, id: 1,
    }),
  });

  const data = await res.json();
  if (data.error) {
    const errData = String(data.error.data || '');
    const match = errData.match(/'([A-Z_]+)'/);
    console.log(`  ${selectorName}: ${match ? match[1] : errData.slice(0, 150)}`);
  } else {
    console.log(`  ${selectorName}: SUCCESS! proof_facts=${data.result?.proof_facts?.length} proof_len=${data.result?.proof?.length}`);
  }
}

async function main() {
  const pubKey = extractPubKeyCoords(PK);
  const { address } = computeStarknetAddress(pubKey);
  const privacyKey = derivePrivacyKey(PK, address);

  const clientActions = [address, privacyKey, '0x1', '0x0', '0xdeadbeef1234'];

  console.log('Testing different selectors with one Call to pool:\n');

  // Try all relevant selectors
  await trySelector('compile_and_panic', clientActions);
  await trySelector('compile_actions', clientActions);
  await trySelector('apply_actions', ['0x0']); // empty server actions
  await trySelector('__execute__', ['0x0']);
  await trySelector('set_viewing_key', ['0xdeadbeef1234']); // just random
}

main().catch(e => { console.error('FATAL:', e.message?.slice(0, 300)); process.exit(1); });
