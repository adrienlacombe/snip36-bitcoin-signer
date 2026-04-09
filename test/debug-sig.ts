/**
 * Debug: call is_valid_signature on our deployed account directly
 * to verify the Bitcoin signature works outside the prover context.
 */
import './setup-crypto';
import { RpcProvider, hash } from 'starknet';
import { LocalBitcoinSigner } from './bitcoin-signer';

const RPC_URL = process.env.VITE_STARKNET_RPC_URL || '';
const ACCOUNT_CLASS_HASH = '0x270accc6dbe5d6b7e107987511b06626e02200e5accb6fa6f3fbb35e4607df2';
const TEST_PK = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

function calculateAddress(pubkeyHash: string): string {
  const addr = hash.calculateContractAddressFromHash(pubkeyHash, ACCOUNT_CLASS_HASH, ['5', pubkeyHash, '1'], 0);
  return '0x' + addr.replace(/^0x/, '').padStart(64, '0');
}

async function main() {
  const provider = new RpcProvider({ nodeUrl: RPC_URL });
  const signer = new LocalBitcoinSigner(TEST_PK);
  const address = calculateAddress(signer.pubkeyHash);

  console.log('account:', address);
  console.log('pubkey_hash:', signer.pubkeyHash);

  // Sign a test hash
  const testHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
  const sig = signer.signHash(testHash);
  console.log('sig:', sig);

  // Call is_valid_signature on our account
  // ABI: is_valid_signature(hash: felt252, signature: Array<felt252>) -> felt252
  // Array<felt252> serialized as [length, ...elements]
  const calldata = [testHash, '0x' + sig.length.toString(16), ...sig];
  console.log('calldata:', calldata);

  try {
    const result = await provider.callContract({
      contractAddress: address,
      entrypoint: 'is_valid_signature',
      calldata,
    });
    console.log('is_valid_signature result:', result);
    console.log(result[0] === '0x56414c4944' ? 'VALID!' : 'INVALID: ' + result[0]);
  } catch (e: any) {
    const msg = e.message || '';
    // Extract felt error
    const felts = msg.match(/0x[0-9a-fA-F]{10,64}/g) || [];
    for (const f of felts) {
      const bytes = Buffer.from(f.slice(2).padStart(f.slice(2).length + (f.slice(2).length % 2), '0'), 'hex');
      const ascii = bytes.toString('ascii').replace(/[^\x20-\x7E]/g, '');
      if (ascii.length > 3 && !ascii.includes('$')) console.log(`  felt: '${ascii}'`);
    }
  }
}

main();
