/**
 * Verify our Bitcoin signer against the contract's test vectors.
 * If these pass, our signing matches the on-chain verification.
 */
import './setup-crypto';
import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/i, '');
  const padded = clean.length % 2 === 0 ? clean : '0' + clean;
  const bytes = new Uint8Array(padded.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(padded.substring(i * 2, i * 2 + 2), 16);
  return bytes;
}
function bytesToHex(b: Uint8Array): string { return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join(''); }

// Contract test vector 1:
const HASH = '0x04a1c2e3d4b5f6a7890123456789abcdef0123456789abcdef0123456789abcd';
const PUBKEY_HASH = '0xc96aaa54e2d44c299564da76e1cd3184a2386b8d';
// sig_1: r and s from the contract test
const R = (0x2086edd8bd10a11e48563a3057bda572n << 128n) | 0x9c6e933df0d2cf9289add73c29e4db4n;
const S = (0x33edc6ff736fc4d2dbda31ed9b9b1fefn << 128n) | 0xf76aa47b8659304923709b878548488cn;
const V = 0; // y_parity: false

// Reconstruct what the contract does:
// 1. Build Bitcoin message: prefix + varint(32) + hash(32 bytes)
const hashBytes = hexToBytes(HASH.slice(2).padStart(64, '0'));
console.log('hash bytes:', bytesToHex(hashBytes));

const prefix = new TextEncoder().encode('\x18Bitcoin Signed Message:\n');
const varint = new Uint8Array([0x20]); // 32
const message = new Uint8Array(prefix.length + varint.length + hashBytes.length);
message.set(prefix, 0);
message.set(varint, prefix.length);
message.set(hashBytes, prefix.length + varint.length);

console.log('message length:', message.length, '(expected 58)');

// 2. Double SHA256
const first = sha256(message);
const double = sha256(first);
console.log('double_sha256:', bytesToHex(double));

// 3. Recover public key from the test vector signature
const rBytes = hexToBytes(R.toString(16).padStart(64, '0'));
const sBytes = hexToBytes(S.toString(16).padStart(64, '0'));
const compactSig = new Uint8Array(64);
compactSig.set(rBytes, 0);
compactSig.set(sBytes, 32);

const sig65 = new Uint8Array(65);
sig65[0] = V;
sig65.set(compactSig, 1);

try {
  const recovered = secp.recoverPublicKey(sig65, double);
  console.log('recovered pubkey:', bytesToHex(recovered));

  // Get uncompressed by recovering with uncompressed flag
  // noble/secp256k1 recoverPublicKey always returns compressed
  // Use getSharedSecret trick or just decompress
  const uncompressed = secp.Point.fromBytes(recovered).toBytes(false);
  console.log('uncompressed:', bytesToHex(uncompressed).slice(0, 20) + '...');

  // Compute pubkey_hash: keccak256(x || y), last 20 bytes
  const kecHash = keccak_256(uncompressed.slice(1));
  const last20 = kecHash.slice(12);
  const recoveredHash = '0x' + bytesToHex(last20);
  console.log('recovered hash:', recoveredHash);
  console.log('expected hash: ', PUBKEY_HASH);
  console.log('MATCH:', recoveredHash === PUBKEY_HASH);
} catch (e: any) {
  console.log('Recovery error:', e.message);
}
