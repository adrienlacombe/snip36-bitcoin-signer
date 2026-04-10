/**
 * E2E test helpers — low-level functions for signing and interacting
 * with Starknet using a local secp256k1 private key (no MetaMask).
 */
import { keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { RpcProvider, hash, CallData, typedData as starknetTypedData, selector as selectorUtil, EthSigner, Account, transaction, ec } from 'starknet';

// ============================================================
// Config
// ============================================================

export const STARKNET_RPC_URL = process.env.VITE_STARKNET_RPC_URL || '';
export const AVNU_PAYMASTER_URL = process.env.VITE_AVNU_PAYMASTER_URL || '';
export const AVNU_API_KEY = process.env.VITE_AVNU_API_KEY || '';
export const PROVING_SERVICE_URL = process.env.VITE_PROVING_SERVICE_URL || '';
export const ETH_ACCOUNT_CLASS_HASH = '0x000b5bcc16b8b0d86c24996e22206f6071bb8d7307837a02720f0ce2fa1b3d7c';
export const PRIVACY_POOL_ADDRESS = '0x254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91';
export const STRK_TOKEN_ADDRESS = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';

const EC_ORDER = 0x0800000000000010ffffffffffffffffb781126dcae7b2321e66a241adc64d2fn;
// Privacy pool requires key < EC_ORDER / 2 (canonical scalar)
const MAX_PRIVATE_KEY = EC_ORDER / 2n - 1n;

// ============================================================
// Public Key Extraction
// ============================================================

export interface PubKeyCoords {
  xLow: string;
  xHigh: string;
  yLow: string;
  yHigh: string;
}

/**
 * Get uncompressed secp256k1 public key from private key.
 * Returns 65 bytes: 0x04 || x[32] || y[32]
 */
export function getUncompressedPubKey(privateKeyHex: string): Uint8Array {
  const privBytes = hexToBytes(privateKeyHex);
  return secp256k1.getPublicKey(privBytes, false);
}

/**
 * Extract (x, y) coordinates as u256 (low, high) pairs from a private key.
 */
export function extractPubKeyCoords(privateKeyHex: string): PubKeyCoords {
  const uncompressed = getUncompressedPubKey(privateKeyHex);
  // Skip 0x04 prefix
  const xBytes = uncompressed.slice(1, 33);
  const yBytes = uncompressed.slice(33, 65);

  const xHex = bytesToHex(xBytes);
  const yHex = bytesToHex(yBytes);

  return {
    xHigh: '0x' + xHex.slice(0, 32),
    xLow: '0x' + xHex.slice(32, 64),
    yHigh: '0x' + yHex.slice(0, 32),
    yLow: '0x' + yHex.slice(32, 64),
  };
}

// ============================================================
// Starknet Address Computation
// ============================================================

export function computeStarknetAddress(pubKey: PubKeyCoords) {
  const constructorCalldata = CallData.compile({
    public_key: {
      x: { low: pubKey.xLow, high: pubKey.xHigh },
      y: { low: pubKey.yLow, high: pubKey.yHigh },
    },
  });

  const salt = hash.computePoseidonHashOnElements([
    pubKey.xLow,
    pubKey.xHigh,
    pubKey.yLow,
    pubKey.yHigh,
  ]);

  const address = hash.calculateContractAddressFromHash(
    salt,
    ETH_ACCOUNT_CLASS_HASH,
    constructorCalldata,
    0,
  );

  return { address, salt, constructorCalldata: constructorCalldata.map(toHexStr) };
}

// ============================================================
// AVNU Paymaster
// ============================================================

export async function deployViaPaymaster(params: {
  address: string;
  salt: string;
  constructorCalldata: string[];
}): Promise<string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: '*/*',
  };
  if (AVNU_API_KEY) {
    headers['x-paymaster-api-key'] = AVNU_API_KEY;
  }

  const rpcBody = {
    jsonrpc: '2.0',
    method: 'paymaster_executeTransaction',
    params: {
      transaction: {
        type: 'deploy',
        deployment: {
          address: toHexStr(params.address),
          class_hash: ETH_ACCOUNT_CLASS_HASH,
          salt: toHexStr(params.salt),
          calldata: params.constructorCalldata.map(toHexStr),
          version: 1,
        },
      },
      parameters: {
        version: '0x1',
        fee_mode: { mode: 'sponsored' },
      },
    },
    id: 1,
  };

  const response = await fetch(AVNU_PAYMASTER_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(rpcBody),
  });

  const result = await response.json();
  if (result.error) {
    throw new Error(`Deploy error: ${result.error.code}: ${result.error.message} ${JSON.stringify(result.error.data ?? '')}`);
  }
  if (!result.result?.transaction_hash) {
    throw new Error(`No tx hash: ${JSON.stringify(result)}`);
  }
  return result.result.transaction_hash;
}

export async function buildInvokeTx(params: {
  userAddress: string;
  calls: Array<{ contractAddress: string; entrypoint: string; calldata: string[] }>;
}): Promise<{ typedData: any }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: '*/*',
  };
  if (AVNU_API_KEY) {
    headers['x-paymaster-api-key'] = AVNU_API_KEY;
  }

  const rpcBody = {
    jsonrpc: '2.0',
    method: 'paymaster_buildTransaction',
    params: {
      transaction: {
        type: 'invoke',
        invoke: {
          user_address: toHexStr(params.userAddress),
          calls: params.calls.map((c) => ({
            to: toHexStr(c.contractAddress),
            selector: selectorUtil.getSelectorFromName(c.entrypoint),
            calldata: c.calldata.map(toHexStr),
          })),
        },
      },
      parameters: {
        version: '0x1',
        fee_mode: { mode: 'sponsored' },
      },
    },
    id: 1,
  };

  const response = await fetch(AVNU_PAYMASTER_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(rpcBody),
  });

  const result = await response.json();
  if (result.error) {
    throw new Error(`Build error: ${result.error.code}: ${result.error.message} ${JSON.stringify(result.error.data ?? '')}`);
  }
  return { typedData: result.result?.typed_data };
}

export async function executeInvokeTx(params: {
  userAddress: string;
  typedData: any;
  signature: string[];
}): Promise<string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: '*/*',
  };
  if (AVNU_API_KEY) {
    headers['x-paymaster-api-key'] = AVNU_API_KEY;
  }

  const rpcBody = {
    jsonrpc: '2.0',
    method: 'paymaster_executeTransaction',
    params: {
      transaction: {
        type: 'invoke',
        invoke: {
          user_address: toHexStr(params.userAddress),
          typed_data: params.typedData,
          signature: params.signature,
        },
      },
      parameters: {
        version: '0x1',
        fee_mode: { mode: 'sponsored' },
      },
    },
    id: 1,
  };

  const response = await fetch(AVNU_PAYMASTER_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(rpcBody),
  });

  const result = await response.json();
  if (result.error) {
    throw new Error(`Execute error: ${result.error.code}: ${result.error.message} ${JSON.stringify(result.error.data ?? '')}`);
  }
  if (!result.result?.transaction_hash) {
    throw new Error(`No tx hash: ${JSON.stringify(result)}`);
  }
  return result.result.transaction_hash;
}

// ============================================================
// Direct Deploy Account (no paymaster — account pays its own gas)
// ============================================================

/**
 * Deploy a new account via DEPLOY_ACCOUNT transaction.
 * The target address must already hold STRK for gas.
 */
export async function deployAccountDirect(params: {
  privateKeyHex: string;
  address: string;
  salt: string;
  constructorCalldata: string[];
}): Promise<string> {
  const provider = getProvider();
  const prefixedKey = params.privateKeyHex.startsWith('0x')
    ? params.privateKeyHex
    : '0x' + params.privateKeyHex;
  const signer = new EthSigner(prefixedKey);
  const account = new Account({ provider, address: params.address, signer });

  const block = await provider.getBlockWithReceipts('latest') as any;
  const l1Price = BigInt(block.l1_gas_price?.price_in_fri ?? '0x400000000000');
  const l1DataPrice = BigInt(block.l1_data_gas_price?.price_in_fri ?? '0x20000');
  const l2Price = BigInt(block.l2_gas_price?.price_in_fri ?? '0x4000000000');

  // EthAccount validate uses secp256k1 which is gas-heavy; estimate + 3x headroom
  const deployPayload = {
    classHash: ETH_ACCOUNT_CLASS_HASH,
    constructorCalldata: params.constructorCalldata,
    addressSalt: params.salt,
  };
  const fee = await account.estimateAccountDeployFee(deployPayload);
  const rb = fee.resourceBounds;
  const result = await account.deployAccount(deployPayload, {
    resourceBounds: {
      l1_gas: { max_amount: BigInt(rb.l1_gas.max_amount) * 3n, max_price_per_unit: BigInt(rb.l1_gas.max_price_per_unit) * 2n },
      l2_gas: { max_amount: BigInt(rb.l2_gas.max_amount) * 3n, max_price_per_unit: BigInt(rb.l2_gas.max_price_per_unit) * 2n },
      l1_data_gas: { max_amount: BigInt(rb.l1_data_gas.max_amount) * 3n, max_price_per_unit: BigInt(rb.l1_data_gas.max_price_per_unit) * 2n },
    },
  });
  return result.transaction_hash;
}

// ============================================================
// Raw secp256k1 Signing (for Starknet typed data)
// ============================================================

/**
 * Sign a Starknet typed data hash with a secp256k1 private key.
 * Returns 5-felt signature: [r_low, r_high, s_low, s_high, v]
 *
 * Uses viem's account.sign() which does RAW secp256k1 signing (no Ethereum prefix).
 * The OZ EthAccountUpgradeable expects ecrecover over the raw hash.
 */
export async function signStarknetHash(privateKeyHex: string, messageHash: string): Promise<string[]> {
  const prefixedKey = (privateKeyHex.startsWith('0x') ? privateKeyHex : '0x' + privateKeyHex) as `0x${string}`;
  const account = privateKeyToAccount(prefixedKey);

  // Pad hash to 32 bytes (felt252 -> bytes32)
  let hashHex = messageHash.startsWith('0x') ? messageHash.slice(2) : messageHash;
  hashHex = hashHex.padStart(64, '0');
  const hash32 = ('0x' + hashHex) as `0x${string}`;

  // Raw sign (no Ethereum prefix) -> 65 bytes: r[32] || s[32] || v[1]
  const ethSig = await account.sign({ hash: hash32 });

  // Parse signature
  const sig = ethSig.slice(2); // remove 0x
  const rHex = sig.slice(0, 64);
  const sHex = sig.slice(64, 128);
  const vByte = parseInt(sig.slice(128, 130), 16);

  // Split r and s into (low, high) u128 pairs
  const rHigh = '0x' + rHex.slice(0, 32);
  const rLow = '0x' + rHex.slice(32, 64);
  const sHigh = '0x' + sHex.slice(0, 32);
  const sLow = '0x' + sHex.slice(32, 64);

  // v: normalize from 27/28 to 0/1
  const v = vByte >= 27 ? vByte - 27 : vByte;

  return [rLow, rHigh, sLow, sHigh, '0x' + v.toString(16)];
}

/**
 * Build + sign + execute an invoke transaction via AVNU paymaster.
 */
export async function signAndExecuteInvoke(params: {
  privateKeyHex: string;
  starknetAddress: string;
  calls: Array<{ contractAddress: string; entrypoint: string; calldata: string[] }>;
}): Promise<string> {
  // Step 1: Build via AVNU
  const { typedData } = await buildInvokeTx({
    userAddress: params.starknetAddress,
    calls: params.calls,
  });

  // Step 2: Compute Starknet SNIP-12 message hash
  const messageHash = starknetTypedData.getMessageHash(
    typedData,
    params.starknetAddress,
  );

  console.log('  Message hash:', messageHash);

  // Step 3: Sign with raw secp256k1
  const signature = await signStarknetHash(params.privateKeyHex, messageHash);
  console.log('  Signature (5-felt):', signature);

  // Step 4: Execute via AVNU
  const txHash = await executeInvokeTx({
    userAddress: params.starknetAddress,
    typedData,
    signature,
  });

  return txHash;
}

// ============================================================
// Direct Invoke (bypasses AVNU, uses account's own gas)
// Required for SNIP-36 privacy pool transactions which need proof_facts
// ============================================================

/**
 * Submit a direct invoke transaction to Starknet (no AVNU paymaster).
 * Uses starknet.js Account + EthSigner for proper serialization.
 */
export async function directInvoke(params: {
  privateKeyHex: string;
  starknetAddress: string;
  calls: Array<{ contractAddress: string; entrypoint: string; calldata: string[] }>;
}): Promise<string> {
  const provider = getProvider();
  const prefixedKey = params.privateKeyHex.startsWith('0x')
    ? params.privateKeyHex
    : '0x' + params.privateKeyHex;
  const signer = new EthSigner(prefixedKey);
  const account = new Account({ provider, address: params.starknetAddress, signer });

  const calls = params.calls.map((c) => ({
    contractAddress: c.contractAddress,
    entrypoint: c.entrypoint,
    calldata: c.calldata,
  }));

  console.log('  Executing via Account.execute(), calls:', calls.length);
  // Fetch current block to derive gas prices, then add a 2x safety margin.
  const block = await provider.getBlockWithReceipts('latest') as any;
  const l1Price = BigInt(block.l1_gas_price?.price_in_fri ?? '0x400000000000');
  const l1DataPrice = BigInt(block.l1_data_gas_price?.price_in_fri ?? '0x20000');
  const l2Price = BigInt(block.l2_gas_price?.price_in_fri ?? '0x4000000000');

  const result = await account.execute(calls, {
    resourceBounds: {
      l1_gas: { max_amount: 0x400n, max_price_per_unit: l1Price * 2n },
      l2_gas: { max_amount: 0xE000000n, max_price_per_unit: l2Price * 2n },
      l1_data_gas: { max_amount: 0x400n, max_price_per_unit: l1DataPrice * 2n },
    },
  });
  return result.transaction_hash;
}

// ============================================================
// Prove and Execute (full proving service flow)
// ============================================================

/**
 * Prove client actions via the privacy pool (sender = pool), then execute
 * on-chain with the returned proof_facts.
 *
 * The privacy pool IS an account contract. During proving:
 *   - sender_address = POOL (not user)
 *   - Pool's __execute__ calls compile_actions + assert_valid_signature
 *   - Pool's __validate__ only checks tip=0, prices=0
 *   - User signs the tx hash so the pool can verify via is_valid_signature
 *
 * After proving, the on-chain submission sends apply_actions(serverActions)
 * through the user's account with proof + proof_facts attached.
 */
export async function proveAndExecute(params: {
  privateKeyHex: string;
  starknetAddress: string;
  clientActions: string[];   // Raw client actions for the prover [addr, key, n, ...actions]
  serverActions: string[];   // From compile_actions, for apply_actions calldata
}): Promise<string> {
  if (!PROVING_SERVICE_URL) throw new Error('VITE_PROVING_SERVICE_URL not set');

  const provider = getProvider();

  // Step 1: Build proving tx with sender = POOL
  // Pool's __execute__ expects Array<Call> — wrap client actions as a call to compile_actions
  const chainId = await provider.getChainId();
  const latestBlock = await provider.getBlockNumber();
  const proveBlock = latestBlock - 20;
  console.log('  Prove block:', proveBlock, '(latest:', latestBlock, ')');
  const poolNonce = await provider.getNonceForAddress(PRIVACY_POOL_ADDRESS, { blockIdentifier: proveBlock });
  const poolNonceHex = poolNonce.startsWith('0x') ? poolNonce : '0x' + BigInt(poolNonce).toString(16);
  const innerCalldata = params.clientActions.map(toHexStr);
  const clientCalldata = [
    '0x1',                                                       // num_calls
    PRIVACY_POOL_ADDRESS,                                        // to (self-call)
    selectorUtil.getSelectorFromName('compile_actions'),          // selector
    '0x' + innerCalldata.length.toString(16),                    // calldata_len
    ...innerCalldata,                                            // calldata
  ];

  const proveResourceBounds = {
    l1_gas: { max_amount: 0x0n, max_price_per_unit: 0x0n },
    l2_gas: { max_amount: 0x20000000n, max_price_per_unit: 0x0n },
    l1_data_gas: { max_amount: 0x0n, max_price_per_unit: 0x0n },
  };

  const txHash = hash.calculateInvokeTransactionHash({
    senderAddress: PRIVACY_POOL_ADDRESS,
    version: '0x3',
    compiledCalldata: clientCalldata,
    chainId,
    nonce: poolNonceHex,
    accountDeploymentData: [],
    nonceDataAvailabilityMode: 0,
    feeDataAvailabilityMode: 0,
    paymasterData: [],
    resourceBounds: proveResourceBounds,
    tip: 0n,
  });

  // Step 2: User signs the tx hash (pool verifies via is_valid_signature on user account)
  console.log('  Signing for proving service...');
  const signature = await signStarknetHash(params.privateKeyHex, txHash);

  // Step 3: Send to proving service
  console.log('  Calling proving service...');
  const proveResponse = await fetch(PROVING_SERVICE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'starknet_proveTransaction',
      params: {
        block_id: { block_number: proveBlock },
        transaction: {
          type: 'INVOKE',
          version: '0x3',
          sender_address: PRIVACY_POOL_ADDRESS,
          calldata: clientCalldata,
          signature: [...signature],
          nonce: poolNonceHex,
          resource_bounds: {
            l1_gas: { max_amount: '0x0', max_price_per_unit: '0x0' },
            l2_gas: { max_amount: '0x20000000', max_price_per_unit: '0x0' },
            l1_data_gas: { max_amount: '0x0', max_price_per_unit: '0x0' },
          },
          tip: '0x0',
          paymaster_data: [],
          account_deployment_data: [],
          nonce_data_availability_mode: 'L1',
          fee_data_availability_mode: 'L1',
        },
      },
      id: 1,
    }),
  });

  const proveResult = await proveResponse.json();
  if (proveResult.error) {
    throw new Error(`Proving failed: ${JSON.stringify(proveResult.error).slice(0, 500)}`);
  }

  const proofFacts = proveResult.result?.proof_facts || proveResult.result?.proofFacts || [];
  const proof = proveResult.result?.proof || '';
  console.log(`  Proof obtained: ${proofFacts.length} proof_facts, ${proof.length} chars proof`);

  // Step 4: Build on-chain tx and submit via raw RPC
  // Must compute tx hash WITH proof_facts, sign it, and submit with proof + proof_facts
  console.log('  Building on-chain tx with proof_facts...');
  const userNonce = await provider.getNonceForAddress(params.starknetAddress);
  const userNonceHex = userNonce.startsWith('0x') ? userNonce : '0x' + BigInt(userNonce).toString(16);

  const block = await provider.getBlockWithReceipts('latest') as any;
  const l1Price = BigInt(block.l1_gas_price?.price_in_fri ?? '0x400000000000');
  const l1DataPrice = BigInt(block.l1_data_gas_price?.price_in_fri ?? '0x20000');
  const l2Price = BigInt(block.l2_gas_price?.price_in_fri ?? '0x4000000000');
  console.log('  User nonce:', userNonceHex, 'l1:', l1Price, 'l2:', l2Price, 'l1data:', l1DataPrice);

  const applyCalldata = transaction.getExecuteCalldata(
    [{ contractAddress: PRIVACY_POOL_ADDRESS, entrypoint: 'apply_actions', calldata: params.serverActions }],
    '1',
  ).map(toHexStr);

  const onchainRb = {
    l1_gas: { max_amount: 0x200n, max_price_per_unit: l1Price * 2n },
    l2_gas: { max_amount: 0x20000000n, max_price_per_unit: l2Price * 2n },
    l1_data_gas: { max_amount: 0x800n, max_price_per_unit: l1DataPrice * 2n },
  };

  // Compute tx hash WITH proof_facts included (required by starknet v0.10.2)
  const onchainTxHash = hash.calculateInvokeTransactionHash({
    senderAddress: params.starknetAddress,
    version: '0x3',
    compiledCalldata: applyCalldata,
    chainId,
    nonce: userNonceHex,
    accountDeploymentData: [],
    nonceDataAvailabilityMode: 0,
    feeDataAvailabilityMode: 0,
    paymasterData: [],
    resourceBounds: onchainRb,
    tip: 0n,
    proofFacts: proofFacts.map((f: string) => BigInt(f)),
  });
  console.log('  On-chain TX hash:', onchainTxHash);

  // Sign the hash (includes proof_facts)
  const onchainSig = await signStarknetHash(params.privateKeyHex, onchainTxHash);

  // Submit via raw RPC with proof_facts + proof in the tx body
  console.log('  Submitting on-chain...');
  const submitRes = await fetch(STARKNET_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'starknet_addInvokeTransaction',
      params: {
        invoke_transaction: {
          type: 'INVOKE',
          version: '0x3',
          sender_address: params.starknetAddress,
          calldata: applyCalldata,
          signature: onchainSig,
          nonce: userNonceHex,
          resource_bounds: {
            l1_gas: { max_amount: toHexStr(onchainRb.l1_gas.max_amount.toString()), max_price_per_unit: toHexStr(onchainRb.l1_gas.max_price_per_unit.toString()) },
            l2_gas: { max_amount: toHexStr(onchainRb.l2_gas.max_amount.toString()), max_price_per_unit: toHexStr(onchainRb.l2_gas.max_price_per_unit.toString()) },
            l1_data_gas: { max_amount: toHexStr(onchainRb.l1_data_gas.max_amount.toString()), max_price_per_unit: toHexStr(onchainRb.l1_data_gas.max_price_per_unit.toString()) },
          },
          tip: '0x0',
          paymaster_data: [],
          account_deployment_data: [],
          nonce_data_availability_mode: 'L1',
          fee_data_availability_mode: 'L1',
          proof_facts: proofFacts,
          proof,
        },
      },
      id: 1,
    }),
  });

  const submitData = await submitRes.json();
  if (submitData.error) {
    throw new Error(`On-chain submit failed: ${JSON.stringify(submitData.error).slice(0, 500)}`);
  }

  return submitData.result.transaction_hash;
}

// ============================================================
// Privacy Key Derivation
// ============================================================

export function derivePrivacyKey(privateKeyHex: string, starknetAddress: string): string {
  // Deterministic: keccak256 of private key + starknet address
  const seed = keccak256(
    ('0x' + privateKeyHex.replace('0x', '') + starknetAddress.replace('0x', '')) as `0x${string}`,
  );
  const raw = BigInt(seed);
  const key = (raw % (MAX_PRIVATE_KEY - 1n)) + 1n;
  return '0x' + key.toString(16);
}

// ============================================================
// Privacy Pool Crypto Helpers
// ============================================================

/** Derive Stark curve public key (x-coordinate) from a privacy/viewing key. */
export function deriveStarkPublicKey(privacyKey: string): string {
  const keyHex = privacyKey.startsWith('0x') ? privacyKey.slice(2) : privacyKey;
  const keyBytes = hexToBytes(keyHex.padStart(64, '0'));
  const pubKeyBytes = ec.starkCurve.getPublicKey(keyBytes);
  // Compressed key: skip prefix byte, take 32-byte x-coordinate
  const xBytes = pubKeyBytes.slice(1, 33);
  return '0x' + bytesToHex(xBytes);
}

/** Encode a short ASCII string as a felt (Cairo short string). */
function shortStringToFelt(str: string): bigint {
  let result = 0n;
  for (let i = 0; i < str.length; i++) {
    result = (result << 8n) | BigInt(str.charCodeAt(i));
  }
  return result;
}

/** Compute channel key: poseidon_hash_span([tag, sender, sender_key, recipient, recipient_pubkey]). */
export function computeChannelKey(
  senderAddr: string,
  senderPrivKey: string,
  recipientAddr: string,
  recipientPubKey: string,
): string {
  const result = ec.starkCurve.poseidonHashMany([
    shortStringToFelt('CHANNEL_KEY_TAG:V1'),
    BigInt(senderAddr),
    BigInt(senderPrivKey),
    BigInt(recipientAddr),
    BigInt(recipientPubKey),
  ]);
  return '0x' + result.toString(16);
}

/** Generate a 120-bit random value for CreateEncNote salt (must be > 1 and < 2^120). */
export function generateRandom120(): string {
  const bytes = new Uint8Array(15); // 15 bytes = 120 bits
  crypto.getRandomValues(bytes);
  let result = 0n;
  for (const byte of bytes) {
    result = (result << 8n) | BigInt(byte);
  }
  if (result <= 1n) result = 2n;
  return '0x' + result.toString(16);
}

// ============================================================
// Starknet RPC helpers
// ============================================================

export function getProvider(): RpcProvider {
  return new RpcProvider({ nodeUrl: STARKNET_RPC_URL });
}

export async function isDeployed(address: string): Promise<boolean> {
  try {
    const classHash = await getProvider().getClassHashAt(address);
    return classHash !== '0x0';
  } catch {
    return false;
  }
}

export async function getStrkBalance(address: string): Promise<bigint> {
  const result = await getProvider().callContract({
    contractAddress: STRK_TOKEN_ADDRESS,
    entrypoint: 'balanceOf',
    calldata: [address],
  });
  const low = BigInt(result[0] ?? '0');
  const high = BigInt(result[1] ?? '0');
  return low + (high << 128n);
}

export async function waitForTx(txHash: string): Promise<'accepted' | 'rejected'> {
  console.log(`  Waiting for tx ${txHash}...`);
  const receipt = await getProvider().waitForTransaction(txHash);
  if (receipt.isReverted()) {
    console.log('  TX REVERTED:', JSON.stringify(receipt.value, null, 2));
    return 'rejected';
  }
  if (receipt.isSuccess()) {
    console.log('  TX accepted, block:', (receipt.value as any).block_number);
    return 'accepted';
  }
  return 'rejected';
}

// ============================================================
// Utility functions
// ============================================================

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  const padded = h.length % 2 === 0 ? h : '0' + h;
  const bytes = new Uint8Array(padded.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function bigintToBytes32(n: bigint): Uint8Array {
  const hex = n.toString(16).padStart(64, '0');
  return hexToBytes(hex);
}

function toHexStr(value: string): string {
  if (value.startsWith('0x')) return value;
  return '0x' + BigInt(value).toString(16);
}

export function formatStrk(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const frac = wei % 10n ** 18n;
  const fracStr = frac.toString().padStart(18, '0').slice(0, 6);
  return `${whole}.${fracStr} STRK`;
}
