/**
 * Probe compile_actions to determine correct action formats.
 * Tests each variant individually and in combinations.
 */
import { RpcProvider } from 'starknet';

const POOL = '0x254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91';
const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const ADDR = '0x342bb789902b87614b14385c8a06af82953d000a05eba8a0b70ac7ca286cb60';
const KEY = '0x3ee4bc89e050c748495aae938c60f4e3dd6a9def3bc04f991581dbfe161541a';

const provider = new RpcProvider({ nodeUrl: process.env.VITE_STARKNET_RPC_URL || '' });
const rand = () => '0x' + Array.from(crypto.getRandomValues(new Uint8Array(31))).map(b => b.toString(16).padStart(2, '0')).join('');
const toHex = (v: string) => v.startsWith('0x') ? v : '0x' + BigInt(v).toString(16);

async function test(name: string, actionPart: string[]) {
  const calldata = [ADDR, KEY, ...actionPart].map(toHex);
  try {
    const r = await provider.callContract({ contractAddress: POOL, entrypoint: 'compile_actions', calldata });
    console.log(`✓ ${name}: OK (${r.length} felts)`);
    return true;
  } catch (e: any) {
    const msg = String(e.message || e);
    // Extract felt-encoded error from revert_error JSON
    const errJson = msg.match(/"error":"(0x[0-9a-fA-F]+)/);
    if (errJson) {
      const hex = errJson[1].slice(2);
      const chars = [];
      for (let i = 0; i < hex.length; i += 2) chars.push(String.fromCharCode(parseInt(hex.substr(i, 2), 16)));
      const decoded = chars.join('').replace(/[^\x20-\x7E]/g, '');
      console.log(`✗ ${name}: ${decoded}`);
    } else {
      const short = msg.match(/Failed to deserialize[^"']*/)?.[0] || msg.slice(0, 80);
      console.log(`✗ ${name}: ${short}`);
    }
    return false;
  }
}

async function main() {
  console.log('=== Probing compile_actions action formats ===\n');

  // Get user's viewing pubkey (needed for some actions)
  let userPubKey = '0x0';
  try {
    const r = await provider.callContract({ contractAddress: POOL, entrypoint: 'get_public_key', calldata: [ADDR] });
    userPubKey = r[0];
    console.log('User viewing key:', userPubKey.slice(0, 16) + '...\n');
  } catch { console.log('No viewing key set\n'); }

  const amt = '1000000000000000'; // 0.001 STRK

  // === Individual actions ===
  console.log('--- Individual actions ---');
  await test('Variant 0: SetViewingKey(rand)', ['1', '0', rand()]);
  await test('Variant 5: Deposit(token, amt)', ['1', '5', STRK, amt]);
  await test('Variant 7: Withdraw(to, token, amt, rand)', ['1', '7', ADDR, STRK, amt, rand()]);

  // === OpenChannel variants (1) ===
  console.log('\n--- OpenChannel (variant 1) field count ---');
  await test('OpenCh: 2 fields (addr, rand)', ['1', '1', ADDR, rand()]);
  await test('OpenCh: 3 fields (addr, 0, rand)', ['1', '1', ADDR, '0', rand()]);
  await test('OpenCh: 4 fields (addr, 0, rand, rand)', ['1', '1', ADDR, '0', rand(), rand()]);
  await test('OpenCh: 5 fields', ['1', '1', ADDR, '0', rand(), rand(), rand()]);

  // === OpenSubchannel variants (2) ===
  console.log('\n--- OpenSubchannel (variant 2) field count ---');
  await test('OpenSub: 4 fields', ['1', '2', ADDR, STRK, '0', rand()]);
  await test('OpenSub: 5 fields', ['1', '2', ADDR, STRK, rand(), '0', rand()]);
  await test('OpenSub: 6 fields', ['1', '2', ADDR, userPubKey, rand(), '0', STRK, rand()]);
  await test('OpenSub: 7 fields', ['1', '2', ADDR, userPubKey, rand(), '0', STRK, rand(), rand()]);

  // === CreateEncNote variants (3) ===
  console.log('\n--- CreateEncNote (variant 3) field count ---');
  await test('CreateNote: 4 fields', ['1', '3', ADDR, STRK, amt, rand()]);
  await test('CreateNote: 5 fields', ['1', '3', ADDR, userPubKey, STRK, amt, rand()]);
  await test('CreateNote: 6 fields', ['1', '3', ADDR, userPubKey, STRK, amt, '0', rand()]);
  await test('CreateNote: 7 fields', ['1', '3', ADDR, userPubKey, STRK, amt, '0', rand(), rand()]);

  // === Variant 4 ===
  console.log('\n--- Variant 4 ---');
  await test('Variant 4: 2 fields', ['1', '4', rand(), rand()]);
  await test('Variant 4: 3 fields', ['1', '4', ADDR, rand(), rand()]);

  // === Variant 6 ===
  console.log('\n--- Variant 6 ---');
  await test('Variant 6: 2 fields', ['1', '6', STRK, amt]);
  await test('Variant 6: 3 fields', ['1', '6', ADDR, STRK, amt]);

  // === Combinations ===
  console.log('\n--- Combinations ---');
  await test('OpenCh + Deposit', ['2', '1', ADDR, '0', rand(), rand(), '5', STRK, amt]);
  await test('OpenCh + Deposit + Withdraw(same)', [
    '3',
    '1', ADDR, '0', rand(), rand(),              // OpenChannel
    '5', STRK, amt,                               // Deposit
    '7', ADDR, STRK, amt, rand(),                 // Withdraw same amount to self
  ]);
  await test('OpenCh + OpenSub(6f) + Deposit + Withdraw', [
    '4',
    '1', ADDR, '0', rand(), rand(),              // OpenChannel
    '2', ADDR, userPubKey, rand(), '0', STRK, rand(), // OpenSubchannel(6f)
    '5', STRK, amt,                               // Deposit
    '7', ADDR, STRK, amt, rand(),                 // Withdraw
  ]);
}

main().catch(e => { console.error('FATAL:', e.message?.slice(0, 200)); process.exit(1); });
