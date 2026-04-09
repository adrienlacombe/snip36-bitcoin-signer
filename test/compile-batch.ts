import { RpcProvider } from 'starknet';
import { keccak256 } from 'viem';

const POOL = '0x254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91';
const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const FORWARDER = '0x75a180e18e56da1b1cae181c92a288f586f5fe22c18df21cf97886f1e4b316c';
const addr = '0x342bb789902b87614b14385c8a06af82953d000a05eba8a0b70ac7ca286cb60';

const EC_ORDER = 0x0800000000000010ffffffffffffffffb781126dcae7b2321e66a241adc64d2fn;
const seed = keccak256(('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' + addr.slice(2)) as `0x${string}`);
const privKey = '0x' + ((BigInt(seed) % (EC_ORDER / 2n - 2n)) + 1n).toString(16);

async function main() {
  const provider = new RpcProvider({ nodeUrl: process.env.VITE_STARKNET_RPC_URL || '' });

  // Try: SetViewingKey + Deposit 2 STRK + Withdraw 1 STRK (fee) in one compile_actions
  try {
    const result = await provider.callContract({
      contractAddress: POOL,
      entrypoint: 'compile_actions',
      calldata: [
        addr, privKey,
        '3',                           // 3 actions
        '0', '0xdeadbeef1234',         // SetViewingKey(random)
        '5', STRK, '2000000000000000000', // Deposit(STRK, 2e18)
        '7',                           // Withdraw
        FORWARDER,                     // to: forwarder
        STRK,                          // token
        '1000000000000000000',         // amount: 1e18 (pool fee)
        '0x1234',                      // random
      ],
    });
    console.log('SUCCESS! Server actions:', result.length, 'felts');
  } catch (e: any) {
    const msg = e.message || '';
    const match = msg.match(/'([A-Z_]+)'/);
    console.log('Error:', match ? match[1] : msg.slice(0, 300));
  }
}

main();
