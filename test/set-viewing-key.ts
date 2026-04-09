/**
 * Test: Set viewing key directly on-chain (no prover).
 */
import { EthSigner, Account, RpcProvider } from 'starknet';
import { keccak256 } from 'viem';

const POOL = '0x254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91';
const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ADDRESS = '0x342bb789902b87614b14385c8a06af82953d000a05eba8a0b70ac7ca286cb60';

const EC_ORDER = 0x0800000000000010ffffffffffffffffb781126dcae7b2321e66a241adc64d2fn;
const MAX_PK = EC_ORDER / 2n - 1n;

async function main() {
  const provider = new RpcProvider({ nodeUrl: process.env.VITE_STARKNET_RPC_URL || '' });
  const signer = new EthSigner(PK);
  const account = new Account({ provider, address: ADDRESS, signer });

  // Derive privacy key
  const seed = keccak256(('0x' + PK.slice(2) + ADDRESS.slice(2)) as `0x${string}`);
  const privacyKey = '0x' + ((BigInt(seed) % (MAX_PK - 1n)) + 1n).toString(16);
  console.log('Privacy key:', privacyKey);

  // Check if viewing key already set
  try {
    const result = await provider.callContract({
      contractAddress: POOL,
      entrypoint: 'get_public_key',
      calldata: [ADDRESS],
    });
    if (result[0] !== '0x0' && result[0] !== '0') {
      console.log('Viewing key already set:', result[0]);
      return;
    }
  } catch {}

  // compile_actions for SetViewingKey
  console.log('Compiling SetViewingKey...');
  const compileResult = await provider.callContract({
    contractAddress: POOL,
    entrypoint: 'compile_actions',
    calldata: [ADDRESS, privacyKey, '1', '0', '0xdeadbeef1234'],
  });
  console.log('Server actions:', compileResult.length, 'felts');

  // Submit directly
  console.log('Executing apply_actions...');
  const result = await account.execute(
    [{
      contractAddress: POOL,
      entrypoint: 'apply_actions',
      calldata: compileResult,
    }],
    {
      resourceBounds: {
        l1_gas: { max_amount: 0x400n, max_price_per_unit: 0x400000000000n },
        l2_gas: { max_amount: 0xE000000n, max_price_per_unit: 0x4000000000n },
        l1_data_gas: { max_amount: 0x400n, max_price_per_unit: 0x20000n },
      },
    },
  );
  console.log('TX:', result.transaction_hash);

  const receipt = await provider.waitForTransaction(result.transaction_hash);
  if (receipt.isSuccess()) {
    console.log('SUCCESS! Viewing key set.');
  } else {
    const val = receipt.value as any;
    console.log('REVERTED:', val.revert_reason);
  }
}

main().catch((e) => { console.error('Error:', e.message?.slice(0, 400)); process.exit(1); });
