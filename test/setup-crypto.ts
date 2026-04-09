/**
 * Must be imported FIRST to configure @noble/secp256k1 hashes.
 * The `hashes` object is exported from @noble/secp256k1 and must be mutated directly.
 */
import { hashes } from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';

hashes.sha256 = (...msgs: Uint8Array[]) => {
  const h = sha256.create();
  msgs.forEach((m) => h.update(m));
  return h.digest();
};

hashes.hmacSha256 = (key: Uint8Array, ...msgs: Uint8Array[]) => {
  const h = hmac.create(sha256, key);
  msgs.forEach((m) => h.update(m));
  return h.digest();
};

console.log('[setup] @noble/secp256k1 hashes configured');
