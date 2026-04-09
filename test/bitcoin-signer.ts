/**
 * Local Bitcoin signer — emulates Ledger Bitcoin app signing.
 *
 * Implements the casawybla signing protocol:
 * 1. Wrap tx hash with Bitcoin message prefix + double SHA256
 * 2. Sign with secp256k1
 * 3. Format as Argent account signature: [1, 5, pubkey_hash, r_low, r_high, s_low, s_high, v]
 */
import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';

// Configure @noble/secp256k1 with hash functions (required in v2)
secp.etc.hmacSha256Sync = (k: Uint8Array, ...m: Uint8Array[]) => {
  const h = hmac.create(sha256, k);
  m.forEach((v) => h.update(v));
  return h.digest();
};
secp.etc.sha256Sync = (...msgs: Uint8Array[]) => {
  const h = sha256.create();
  msgs.forEach((m) => h.update(m));
  return h.digest();
};
import {
  type SignerInterface,
  type Signature,
  type Call,
  type DeclareSignerDetails,
  type DeployAccountSignerDetails,
  type InvocationsSignerDetails,
  type TypedData,
  hash,
  transaction,
  CallData,
  ec,
} from 'starknet';

const CURVE_ORDER = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
const HALF_CURVE_ORDER = CURVE_ORDER / 2n;

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

function splitU256(value: bigint): [string, string] {
  const mask = (1n << 128n) - 1n;
  return ['0x' + (value & mask).toString(16), '0x' + (value >> 128n).toString(16)];
}

function intDAM(dam: any): number {
  if (typeof dam === 'number') return dam;
  if (dam === 'L1' || dam === 0) return 0;
  if (dam === 'L2' || dam === 1) return 1;
  return 0;
}

/**
 * Derives the pubkey_hash as Poseidon(x_low, x_high, y_low, y_high) from a secp256k1 private key.
 * This matches the on-chain verification in the modified Bitcoin signer contract.
 */
export function derivePubkeyHash(privateKeyHex: string): string {
  const privBytes = hexToBytes(privateKeyHex);
  const uncompressed = secp.getPublicKey(privBytes, false); // 65 bytes: 0x04 || x(32) || y(32)
  const xHex = bytesToHex(uncompressed.slice(1, 33));
  const yHex = bytesToHex(uncompressed.slice(33, 65));

  // Split into u256 (low, high) pairs — matches Cairo's u256 { low: u128, high: u128 }
  const xLow = BigInt('0x' + xHex.slice(32, 64));
  const xHigh = BigInt('0x' + xHex.slice(0, 32));
  const yLow = BigInt('0x' + yHex.slice(32, 64));
  const yHigh = BigInt('0x' + yHex.slice(0, 32));

  // Poseidon hash matching: poseidon_hash_span([x_low, x_high, y_low, y_high])
  const h = ec.starkCurve.poseidonHashMany([xLow, xHigh, yLow, yHigh]);
  return '0x' + h.toString(16);
}

/**
 * Signs a Starknet tx hash using Bitcoin message format (emulates Ledger Bitcoin app).
 *
 * Bitcoin signing:
 * 1. message = "\x18Bitcoin Signed Message:\n" + varint(32) + txHash(32 bytes)
 * 2. digest = SHA256(SHA256(message))
 * 3. Sign digest with secp256k1
 */
function signBitcoin(privateKeyHex: string, txHash: string): { r: bigint; s: bigint; v: number } {
  const hashBytes = hexToBytes(txHash.replace(/^0x/, '').padStart(64, '0'));

  // Bitcoin message format: prefix + varint(32) + 32 bytes of hash
  const prefix = new TextEncoder().encode('\x18Bitcoin Signed Message:\n');
  const varint = new Uint8Array([32]); // varint for length 32
  const message = new Uint8Array(prefix.length + varint.length + hashBytes.length);
  message.set(prefix, 0);
  message.set(varint, prefix.length);
  message.set(hashBytes, prefix.length + varint.length);

  // Double SHA256
  const digest = sha256(sha256(message));

  // Sign with secp256k1
  const privBytes = hexToBytes(privateKeyHex);
  const sigBytes = secp.sign(digest, privBytes, { prehash: false });

  // noble/secp256k1 v2: sign() returns Uint8Array(64) = r[32] || s[32]
  const rBytes = sigBytes.slice(0, 32);
  const sBytes = sigBytes.slice(32, 64);
  let r = BigInt('0x' + bytesToHex(rBytes));
  let s = BigInt('0x' + bytesToHex(sBytes));

  // Determine y_parity for the Cairo contract.
  // y_parity=false(0) means even R.y, y_parity=true(1) means odd R.y.
  // Use Noble's recoverPublicKey with prehash:false to match our signing.
  const pubCompressed = secp.getPublicKey(privBytes, true);
  let v = 0;
  for (const tryV of [0, 1]) {
    try {
      const sig65 = new Uint8Array(65);
      sig65[0] = tryV;
      sig65.set(sigBytes, 1);
      const recovered = secp.recoverPublicKey(sig65, digest, { prehash: false });
      if (bytesToHex(recovered) === bytesToHex(pubCompressed)) {
        v = tryV;
        break;
      }
    } catch {}
  }

  // Low-s normalization
  if (s > HALF_CURVE_ORDER) {
    s = CURVE_ORDER - s;
    v = v ^ 1;
  }

  return { r, s, v };
}

/**
 * Local Bitcoin signer for Starknet — emulates Ledger hardware wallet.
 * Drop-in replacement for BitcoinLedgerSigner from casawybla.
 */
export class LocalBitcoinSigner implements SignerInterface {
  private privateKeyHex: string;
  public readonly pubkeyHash: string;

  constructor(privateKeyHex: string) {
    this.privateKeyHex = privateKeyHex.replace(/^0x/, '');
    this.pubkeyHash = derivePubkeyHash(this.privateKeyHex);
  }

  async getPubKey(): Promise<string> {
    return this.pubkeyHash;
  }

  async signMessage(typedData: TypedData, accountAddress: string): Promise<Signature> {
    // Compute SNIP-12 typed data hash, then sign with Bitcoin message format
    const { typedData: starknetTypedData } = await import('starknet');
    const msgHash = starknetTypedData.getMessageHash(typedData, accountAddress);
    return this.signHash(msgHash);
  }

  async signTransaction(transactions: Call[], details: InvocationsSignerDetails): Promise<Signature> {
    const compiledCalldata = transaction.getExecuteCalldata(transactions, details.cairoVersion || '1');
    const det = details as any;
    const senderAddress = det.walletAddress || det.senderAddress;
    console.log('[signer] signTransaction sender:', senderAddress, 'nonce:', det.nonce, 'version:', det.version);
    console.log('[signer] details keys:', Object.keys(det).sort().join(', '));
    console.log('[signer] chainId:', det.chainId, 'tip:', det.tip);
    console.log('[signer] resourceBounds l2_gas:', det.resourceBounds?.l2_gas);
    if (det.proofFacts) console.log('[signer] proofFacts:', det.proofFacts.length, 'elements');
    console.log('[signer] calldata first 3:', compiledCalldata.slice(0, 3));
    // Strip proofFacts from hash — the SDK's proof invocation doesn't include them
    // (proof invocation uses the pool as sender with zero resource bounds, no proofFacts)
    // For on-chain submission, proofFacts ARE included by the privacy fork's hash function
    const { proofFacts: _pf, proof: _pr, ...cleanDet } = det;
    const msgHash = hash.calculateInvokeTransactionHash({
      ...cleanDet,
      senderAddress,
      compiledCalldata,
      version: det.version,
      paymasterData: det.paymasterData || [],
      accountDeploymentData: det.accountDeploymentData || [],
      nonceDataAvailabilityMode: intDAM(det.nonceDataAvailabilityMode),
      feeDataAvailabilityMode: intDAM(det.feeDataAvailabilityMode),
      tip: det.tip ?? 0,
    });
    console.log('[signer] tx hash:', msgHash);
    return this.signHash(msgHash);
  }

  async signDeployAccountTransaction(details: DeployAccountSignerDetails): Promise<Signature> {
    const compiledConstructorCalldata = CallData.compile(details.constructorCalldata);
    const det = details as any;
    const msgHash = hash.calculateDeployAccountTransactionHash({
      ...det,
      salt: det.addressSalt,
      compiledConstructorCalldata,
      version: det.version,
      paymasterData: det.paymasterData || [],
      accountDeploymentData: det.accountDeploymentData || [],
      nonceDataAvailabilityMode: intDAM(det.nonceDataAvailabilityMode),
      feeDataAvailabilityMode: intDAM(det.feeDataAvailabilityMode),
      tip: det.tip ?? 0,
    });
    return this.signHash(msgHash);
  }

  async signDeclareTransaction(_details: DeclareSignerDetails): Promise<Signature> {
    throw new Error('signDeclareTransaction not implemented');
  }

  /**
   * Sign a tx hash using Bitcoin message format.
   * Returns Argent signature: [1, 5, pubkey_hash, r_low, r_high, s_low, s_high, v]
   */
  signHash(txHash: string): Signature {
    const { r, s, v } = signBitcoin(this.privateKeyHex, txHash);
    const [rLow, rHigh] = splitU256(r);
    const [sLow, sHigh] = splitU256(s);

    return [
      '1',              // 1 signature (owner only, no guardian)
      '2',              // SignerSignature::Bitcoin variant (stripped enum: Starknet=0, Secp256k1=1, Bitcoin=2)
      this.pubkeyHash,  // BitcoinSigner { pubkey_hash }
      rLow, rHigh,
      sLow, sHigh,
      v.toString(),
    ];
  }
}
