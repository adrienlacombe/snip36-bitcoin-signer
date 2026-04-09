/**
 * Direct on-chain submission with proof_facts — bypasses AVNU forwarder entirely.
 * User's account calls apply_actions directly, with proof + proof_facts in the tx.
 */
import './setup-crypto';
import { RpcProvider, hash, selector as sel, Account } from 'starknet';
import { LocalBitcoinSigner } from './bitcoin-signer';

const RPC_URL = process.env.VITE_STARKNET_RPC_URL || '';
const PROVING_URL = process.env.VITE_PROVING_SERVICE_URL || '';
const POOL = '0x254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91';
const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const ACCOUNT_CLASS_HASH = '0x547b1790e63a72b6a48c18055ae37cfe4191ae8a6980472b4546f07984d2386';
const TEST_PK = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const EC_ORDER = 0x0800000000000010ffffffffffffffffb781126dcae7b2321e66a241adc64d2fn;
const VIEWING_KEY = '0x' + ((0x12345678deadbeefn % (EC_ORDER / 2n - 1n)) + 1n).toString(16);
const toHex = (v: string) => v.startsWith('0x') ? v : '0x' + BigInt(v).toString(16);

async function main() {
  const provider = new RpcProvider({ nodeUrl: RPC_URL, specVersion: '0.10.1' });
  const signer = new LocalBitcoinSigner(TEST_PK);
  const addr = '0x' + hash.calculateContractAddressFromHash(signer.pubkeyHash, ACCOUNT_CLASS_HASH, ['2', signer.pubkeyHash, '1'], 0).replace(/^0x/, '').padStart(64, '0');
  const account = new Account({ provider, address: addr, signer, cairoVersion: '1' });

  console.log('user:', addr);
  const chainId = await provider.getChainId();
  const latestBlock = await provider.getBlockNumber();
  // Tight window: account must exist at prove block, proof must not expire before inclusion
  // proof_validity_blocks = 450, leave ~20 blocks buffer for proving + submission
  const proveBlock = latestBlock - 430;
  const poolNonce = await provider.getNonceForAddress(POOL, { blockIdentifier: proveBlock });

  // SetViewingKey only — no deposit/withdraw, no fee
  const random = '0xdeadbeef' + Date.now().toString(16);
  const clientActions = ['1', '0', random];

  // Compile
  const serverActions = await provider.callContract({
    contractAddress: POOL, entrypoint: 'compile_actions',
    calldata: [addr, VIEWING_KEY, ...clientActions],
  });
  console.log('server actions:', serverActions.length);

  // Prove
  console.log('proving...');
  const innerCalldata = [addr, VIEWING_KEY, ...clientActions].map(toHex);
  const executeCalldata = ['0x1', POOL, sel.getSelectorFromName('compile_actions'), '0x' + innerCalldata.length.toString(16), ...innerCalldata];
  const rb = { l1_gas: { max_amount: 0x1n, max_price_per_unit: 0x0n }, l2_gas: { max_amount: 0x20000000n, max_price_per_unit: 0x0n }, l1_data_gas: { max_amount: 0x0n, max_price_per_unit: 0x0n } };
  const txHash = hash.calculateInvokeTransactionHash({ senderAddress: POOL, version: '0x3', compiledCalldata: executeCalldata, chainId, nonce: toHex(poolNonce), accountDeploymentData: [], nonceDataAvailabilityMode: 0, feeDataAvailabilityMode: 0, paymasterData: [], resourceBounds: rb, tip: 0n });
  const sig = signer.signHash(txHash);

  const res = await fetch(PROVING_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'starknet_proveTransaction', params: { block_id: { block_number: proveBlock }, transaction: { type: 'INVOKE', version: '0x3', sender_address: POOL, calldata: executeCalldata, signature: sig.map(toHex), nonce: toHex(poolNonce), resource_bounds: { l1_gas: { max_amount: '0x1', max_price_per_unit: '0x0' }, l2_gas: { max_amount: '0x20000000', max_price_per_unit: '0x0' }, l1_data_gas: { max_amount: '0x0', max_price_per_unit: '0x0' } }, tip: '0x0', paymaster_data: [], account_deployment_data: [], nonce_data_availability_mode: 'L1', fee_data_availability_mode: 'L1' } }, id: 1 }),
  });
  const proveData = await res.json();
  if (proveData.error) { console.log('prove error:', String(proveData.error.data).slice(0, 300)); process.exit(1); }

  const { proof, proof_facts: proofFacts } = proveData.result;
  console.log('proof:', proof.length, 'chars, proof_facts:', proofFacts.length);
  // Decode proof_facts - element 4 is the block number
  for (let i = 0; i < proofFacts.length; i++) {
    const h = proofFacts[i].replace(/^0x/, '');
    const n = BigInt('0x' + h);
    const ascii = Buffer.from(h.padStart(h.length + (h.length % 2), '0'), 'hex').toString('ascii').replace(/[^\x20-\x7E]/g, '');
    console.log(`  pf[${i}]: ${proofFacts[i]}${ascii.length > 3 ? ' ("' + ascii + '")' : ''} ${n < 100000000n ? '= ' + n : ''}`);
  }

  // Build calldata for __execute__(Array<Call>)
  const { transaction, selector: selUtil } = await import('starknet');
  const compiledCalldata = transaction.getExecuteCalldata(
    [{ contractAddress: POOL, entrypoint: 'apply_actions', calldata: serverActions }], '1'
  );

  // Get nonce
  const userNonce = await provider.getNonceForAddress(addr);

  // Compute tx hash — include proofFacts since node at v0.10.2 includes them when present in tx body
  const onchainHash = hash.calculateInvokeTransactionHash({
    senderAddress: addr, version: '0x3',
    compiledCalldata: compiledCalldata.map(toHex), chainId,
    nonce: toHex(userNonce), accountDeploymentData: [],
    nonceDataAvailabilityMode: 0, feeDataAvailabilityMode: 0,
    paymasterData: [],
    resourceBounds: { l1_gas: { max_amount: 0x200n, max_price_per_unit: 0x800000000000n }, l2_gas: { max_amount: 0x20000000n, max_price_per_unit: 0x1000000000n }, l1_data_gas: { max_amount: 0x400n, max_price_per_unit: 0x800000000000n } },
    tip: 0n,
    proofFacts: proofFacts.map((f: string) => BigInt(f)),
  });
  console.log('nonce:', userNonce, 'hash:', onchainHash);

  const onchainSig = signer.signHash(onchainHash);
  console.log('submitting via raw RPC with proof + proof_facts...');

  const submitRes = await fetch(RPC_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'starknet_addInvokeTransaction',
      params: { invoke_transaction: {
        type: 'INVOKE', version: '0x3',
        sender_address: addr,
        calldata: compiledCalldata.map(toHex),
        signature: onchainSig.map(toHex),
        nonce: toHex(userNonce),
        resource_bounds: {
          l1_gas: { max_amount: '0x200', max_price_per_unit: '0x800000000000' },
          l2_gas: { max_amount: '0x20000000', max_price_per_unit: '0x1000000000' },
          l1_data_gas: { max_amount: '0x400', max_price_per_unit: '0x800000000000' },
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
    const msg = String(submitData.error.data || '');
    if (msg.includes('invalid signature') || msg.includes('invalid-owner-sig')) console.log('INVALID SIG');
    else if (msg.includes('EMPTY_PROOF')) console.log('EMPTY_PROOF_FACTS');
    else if (msg.includes('Resource')) console.log('RESOURCE:', msg.slice(0, 200));
    else console.log('ERROR:', msg.slice(0, 300));
  } else {
    const txHash = submitData.result.transaction_hash;
    console.log('TX:', txHash);
    const receipt = await provider.waitForTransaction(txHash);
    if (receipt.isSuccess()) console.log('SUCCESS!!');
    else console.log('REVERTED:', (receipt.value as any).revert_reason?.slice(0, 300));
  }
}

main().catch(e => { console.error('FATAL:', e.message?.slice(0, 300)); process.exit(1); });
