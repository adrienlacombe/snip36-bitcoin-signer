import './setup-crypto';
import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { LocalBitcoinSigner } from './bitcoin-signer';

const PK = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/i, '');
  const padded = clean.length % 2 === 0 ? clean : '0' + clean;
  const bytes = new Uint8Array(padded.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(padded.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Test: sign a hash and verify we can recover the correct public key
const signer = new LocalBitcoinSigner(PK);
const testHash = '0x30c81a95796c9f7102967b6cfd90f3306ba71aea81c295fb4c36208bcab12eb';

console.log('Pubkey hash:', signer.pubkeyHash);
const sig = signer.signHash(testHash);
console.log('Signature:', sig);

// Now verify: the Argent contract does Bitcoin message verification
// 1. Wrap hash in Bitcoin message format
// 2. Double SHA256
// 3. ecrecover
const hashBytes = hexToBytes(testHash.replace(/^0x/, '').padStart(64, '0'));
const prefix = new TextEncoder().encode('\x18Bitcoin Signed Message:\n');
const varint = new Uint8Array([32]);
const message = new Uint8Array(prefix.length + varint.length + hashBytes.length);
message.set(prefix, 0);
message.set(varint, prefix.length);
message.set(hashBytes, prefix.length + varint.length);
const digest = sha256(sha256(message));

// Extract r, s, v from our signature format [1, 5, pubkeyHash, rLow, rHigh, sLow, sHigh, v]
const rLow = BigInt(sig[3]);
const rHigh = BigInt(sig[4]);
const sLow = BigInt(sig[5]);
const sHigh = BigInt(sig[6]);
const v = Number(sig[7]);

const r = rLow + (rHigh << 128n);
const s = sLow + (sHigh << 128n);

console.log('r:', '0x' + r.toString(16));
console.log('s:', '0x' + s.toString(16));
console.log('v:', v);

// Reconstruct compact sig bytes
const rBytes = hexToBytes(r.toString(16).padStart(64, '0'));
const sBytes = hexToBytes(s.toString(16).padStart(64, '0'));
const compactSig = new Uint8Array(64);
compactSig.set(rBytes, 0);
compactSig.set(sBytes, 32);

// Recover public key
try {
  // noble/secp256k1 v2 recovered format: [recovery, r(32), s(32)]
  const sig65 = new Uint8Array(65);
  sig65[0] = v;
  sig65.set(compactSig, 1);
  const recovered = secp.recoverPublicKey(sig65, digest);
  console.log('Recovered pubkey:', '0x' + bytesToHex(recovered));

  // Compute pubkey hash (keccak160)
  const kecHash = keccak_256(recovered.slice(1));
  const last20 = kecHash.slice(12);
  const recoveredHash = '0x' + bytesToHex(last20);
  console.log('Recovered hash:', recoveredHash);
  console.log('Expected hash: ', signer.pubkeyHash);
  console.log('MATCH:', recoveredHash === signer.pubkeyHash);
} catch (e: any) {
  console.log('Recovery failed:', e.message);
}
