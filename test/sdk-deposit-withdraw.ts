/**
 * SDK-based deposit + withdraw test.
 * SDK handles action construction (channels, notes, etc.)
 * We handle signing (Bitcoin signer) and submission (raw RPC with proof_facts).
 */
import './setup-crypto';
import { Account, RpcProvider, hash, constants, transaction } from 'starknet';
import { createPrivateTransfers } from '@starkware-libs/starknet-privacy-sdk';
import { LocalBitcoinSigner } from './bitcoin-signer';

const RPC_URL = process.env.VITE_STARKNET_RPC_URL || '';
const PROVING_URL = process.env.VITE_PROVING_SERVICE_URL || '';
const DISCOVERY_URL = process.env.VITE_DISCOVERY_SERVICE_URL || '';
const POOL = '0x254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91';
const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const CLASS_HASH = '0x547b1790e63a72b6a48c18055ae37cfe4191ae8a6980472b4546f07984d2386';
const PK = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const EC_ORDER = 0x0800000000000010ffffffffffffffffb781126dcae7b2321e66a241adc64d2fn;
const VIEWING_KEY = (0x12345678deadbeefn % (EC_ORDER / 2n - 1n)) + 1n;

const toHex = (v: string) => v.startsWith('0x') ? v : '0x' + BigInt(v).toString(16);

async function submitWithProof(
  signer: LocalBitcoinSigner, address: string, call: any, proof: any,
): Promise<string> {
  const provider = new RpcProvider({ nodeUrl: RPC_URL });
  const chainId = await provider.getChainId();
  const nonce = await provider.getNonceForAddress(address);
  const calldata = transaction.getExecuteCalldata([call], '1').map(toHex);
  const rb = { l1_gas: { max_amount: 0x200n, max_price_per_unit: 0x800000000000n },
    l2_gas: { max_amount: 0x20000000n, max_price_per_unit: 0x1000000000n },
    l1_data_gas: { max_amount: 0x800n, max_price_per_unit: 0x800000000000n } };
  const txHash = hash.calculateInvokeTransactionHash({
    senderAddress: address, version: '0x3', compiledCalldata: calldata, chainId,
    nonce: toHex(nonce), accountDeploymentData: [], nonceDataAvailabilityMode: 0,
    feeDataAvailabilityMode: 0, paymasterData: [], resourceBounds: rb, tip: 0n,
    proofFacts: proof.proofFacts.map((f: string) => BigInt(f)),
  });
  const sig = signer.signHash(txHash);
  const res = await fetch(RPC_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'starknet_addInvokeTransaction', params: {
      invoke_transaction: { type: 'INVOKE', version: '0x3', sender_address: address,
        calldata, signature: sig.map(toHex), nonce: toHex(nonce),
        resource_bounds: { l1_gas: { max_amount: '0x200', max_price_per_unit: '0x800000000000' },
          l2_gas: { max_amount: '0x20000000', max_price_per_unit: '0x1000000000' },
          l1_data_gas: { max_amount: '0x800', max_price_per_unit: '0x800000000000' } },
        tip: '0x0', paymaster_data: [], account_deployment_data: [],
        nonce_data_availability_mode: 'L1', fee_data_availability_mode: 'L1',
        proof_facts: proof.proofFacts, proof: proof.data,
      }}, id: 1 }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Submit: ${String(data.error.data || data.error.message).slice(0, 300)}`);
  return data.result.transaction_hash;
}

async function main() {
  console.log('SDK Deposit + Withdraw Test\n');
  const provider = new RpcProvider({ nodeUrl: RPC_URL });
  const signer = new LocalBitcoinSigner(PK);
  const address = '0x' + hash.calculateContractAddressFromHash(signer.pubkeyHash, CLASS_HASH, ['2', signer.pubkeyHash, '1'], 0).replace(/^0x/, '').padStart(64, '0');
  const account = new Account({ provider, address, signer, cairoVersion: '1' });

  console.log('user:', address);

  const transfers = createPrivateTransfers({
    account,
    viewingKeyProvider: { getViewingKey: async () => VIEWING_KEY },
    provingProvider: { url: PROVING_URL, chainId: constants.StarknetChainId.SN_SEPOLIA },
    discoveryProvider: { url: DISCOVERY_URL },
    poolContractAddress: POOL,
  });

  // --- Approve ---
  const depositAmount = 10000000000000000n; // 0.01 STRK
  console.log('\nApproving STRK...');
  const approveTx = await account.execute(
    [{ contractAddress: STRK, entrypoint: 'approve', calldata: [POOL, depositAmount.toString(), '0'] }],
    { tip: 0n, resourceBounds: { l1_gas: { max_amount: 0x200n, max_price_per_unit: 0x800000000000n }, l2_gas: { max_amount: 0x20000000n, max_price_per_unit: 0x1000000000n }, l1_data_gas: { max_amount: 0x800n, max_price_per_unit: 0x800000000000n } } },
  );
  await provider.waitForTransaction(approveTx.transaction_hash);
  console.log('approved');

  // --- Deposit ---
  console.log('\nBuilding deposit via SDK...');
  const latestBlock = await provider.getBlockNumber();
  const depResult = await transfers.build({ autoSetup: true, provingBlockId: latestBlock - 440 })
    .with(STRK, (t: any) => t.deposit({ amount: depositAmount }))
    .surplusTo(address)
    .execute();

  console.log('SDK call:', depResult.callAndProof.call.entrypoint);
  console.log('proof_facts:', depResult.callAndProof.proof.proofFacts?.length);
  console.log('warnings:', depResult.warnings);

  console.log('\nSubmitting deposit...');
  const depTxHash = await submitWithProof(signer, address, depResult.callAndProof.call, depResult.callAndProof.proof);
  console.log('TX:', depTxHash);
  const depReceipt = await provider.waitForTransaction(depTxHash);
  if (depReceipt.isSuccess()) console.log('DEPOSIT SUCCESS!');
  else {
    const reason = (depReceipt.value as any).revert_reason || '';
    const felts = reason.match(/0x[0-9a-fA-F]{10,40}/g) || [];
    const decoded = felts.map((f: string) => { const h = f.slice(2); return Buffer.from(h.padStart(h.length+(h.length%2),'0'), 'hex').toString('ascii').replace(/[^\x20-\x7E]/g, ''); }).filter((s: string) => s.length > 4);
    console.log('DEPOSIT REVERTED:', decoded.join(' | ') || reason.slice(0, 200));
    process.exit(1);
  }

  // --- Withdraw ---
  console.log('\nBuilding withdraw via SDK...');
  const latestBlock2 = await provider.getBlockNumber();
  const wResult = await transfers.build({ autoSelectNotes: 'all', provingBlockId: latestBlock2 - 440 })
    .with(STRK, (t: any) => t.withdraw({ recipient: address, amount: 5000000000000000n }))
    .surplusTo(address)
    .execute();

  console.log('SDK call:', wResult.callAndProof.call.entrypoint);
  console.log('\nSubmitting withdraw...');
  const wTxHash = await submitWithProof(signer, address, wResult.callAndProof.call, wResult.callAndProof.proof);
  console.log('TX:', wTxHash);
  const wReceipt = await provider.waitForTransaction(wTxHash);
  if (wReceipt.isSuccess()) console.log('WITHDRAW SUCCESS!');
  else {
    const reason = (wReceipt.value as any).revert_reason || '';
    console.log('WITHDRAW REVERTED:', reason.slice(0, 200));
    process.exit(1);
  }

  console.log('\n=== ALL PASSED ===');
}

main().catch(e => { console.error('\nFATAL:', e.message?.slice(0, 500)); process.exit(1); });
