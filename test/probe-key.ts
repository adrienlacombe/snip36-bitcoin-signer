import { RpcProvider } from 'starknet';

const provider = new RpcProvider({ nodeUrl: process.env.VITE_STARKNET_RPC_URL || '' });
const POOL = '0x254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91';
const addr = '0x342bb789902b87614b14385c8a06af82953d000a05eba8a0b70ac7ca286cb60';

const EC_ORDER = 0x0800000000000010ffffffffffffffffb781126dcae7b2321e66a241adc64d2fn;
const STARK_PRIME = 0x800000000000011000000000000000000000000000000000000000000000001n;

async function tryKey(label: string, key: bigint) {
  const keyHex = '0x' + key.toString(16);
  try {
    await provider.callContract({
      contractAddress: POOL,
      entrypoint: 'compile_actions',
      calldata: [addr, keyHex, '1', '0', '0x1234'],
    });
    console.log(label.padEnd(30), 'OK', '  key_hex:', keyHex.slice(0, 20) + '...');
  } catch (e: any) {
    const msg = e.message || '';
    if (msg.includes('CANONICAL')) {
      console.log(label.padEnd(30), 'FAIL', 'key_hex:', keyHex.slice(0, 20) + '...');
    } else {
      // Extract the short error
      const match = msg.match(/'([A-Z_]+)'/);
      console.log(label.padEnd(30), 'ERR:', match?.[1] || msg.slice(0, 60));
    }
  }
}

async function main() {
  console.log('=== Power of 2 boundaries ===');
  for (const bits of [128, 240, 248, 250, 251, 252]) {
    await tryKey(`2^${bits} - 1`, (1n << BigInt(bits)) - 1n);
  }

  console.log('\n=== Around EC_ORDER ===');
  await tryKey('EC_ORDER - 2', EC_ORDER - 2n);
  await tryKey('EC_ORDER - 1', EC_ORDER - 1n);
  await tryKey('EC_ORDER', EC_ORDER);
  await tryKey('EC_ORDER + 1', EC_ORDER + 1n);

  console.log('\n=== Around STARK_PRIME ===');
  await tryKey('STARK_PRIME - 2', STARK_PRIME - 2n);
  await tryKey('STARK_PRIME - 1', STARK_PRIME - 1n);
  await tryKey('STARK_PRIME', STARK_PRIME);
  await tryKey('STARK_PRIME + 1', STARK_PRIME + 1n);

  console.log('\n=== Specific values ===');
  await tryKey('2^251', 1n << 251n);
  await tryKey('2^251 - 1', (1n << 251n) - 1n);
  await tryKey('Our failing key', 0x7ee4bc89e050c7d0495aae938c60f4e19973315d92fde12a08b6ee0b8447a6bn);

  console.log('\n=== Binary search around 2^251 ===');
  // EC_ORDER starts with 0x08000... which is just above 2^251
  const base = 1n << 251n;
  for (let i = 0n; i < 20n; i++) {
    await tryKey(`2^251 + ${i}`, base + i);
  }
}

main();
