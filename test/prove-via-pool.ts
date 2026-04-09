/**
 * Test: Prove via the privacy pool as the sender account.
 *
 * The privacy pool contract IS an account (has __execute__ and __validate__).
 * Per Section 8 of the paper, the virtual execution uses the pool's __execute__
 * which internally calls compile_and_panic and verifies the user's signature
 * via is_valid_signature on the user's account.
 *
 * The calldata for the pool's __execute__ should contain the client-side actions
 * wrapped in a Call to compile_and_panic.
 */
import { RpcProvider, hash, CallData, selector as sel } from 'starknet';
import { signStarknetHash, extractPubKeyCoords, computeStarknetAddress, derivePrivacyKey, PRIVACY_POOL_ADDRESS } from './e2e-helpers';

const PK = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const PROVING_URL = process.env.VITE_PROVING_SERVICE_URL || '';

const toHex = (v: string) => v.startsWith('0x') ? v : '0x' + BigInt(v).toString(16);

async function main() {
  const provider = new RpcProvider({ nodeUrl: process.env.VITE_STARKNET_RPC_URL || '' });
  const pubKey = extractPubKeyCoords(PK);
  const { address: userAddress } = computeStarknetAddress(pubKey);
  const privacyKey = derivePrivacyKey(PK, userAddress);
  const chainId = await provider.getChainId();

  console.log('User account:', userAddress);
  console.log('Privacy pool:', PRIVACY_POOL_ADDRESS);
  console.log('Privacy key:', privacyKey);

  // The pool is the sender — get its nonce
  const poolNonce = await provider.getNonceForAddress(PRIVACY_POOL_ADDRESS);
  console.log('Pool nonce:', poolNonce);

  // Build the calldata for the pool's __execute__
  // The pool's __execute__ takes Array<Call>
  // We send a call to itself (compile_and_panic)
  const clientActions = ['1', '0', '0xdeadbeef1234']; // 1 action: SetViewingKey(random)

  // The pool's __execute__ might take client actions directly as calldata
  // (not wrapped in Call structs), since it's a custom account contract.
  // Try multiple approaches:

  const approach = process.argv[2] || 'raw';
  let executeCalldata: string[];

  if (approach === 'raw') {
    // Approach 1: raw client actions as calldata
    console.log('Approach: raw client actions as calldata');
    executeCalldata = [userAddress, privacyKey, ...clientActions].map(toHex);
  } else if (approach === 'call-self') {
    // Approach 2: Call to self with compile_and_panic, wrapped in __execute__ format
    console.log('Approach: Call to self with compile_and_panic');
    const innerCalldata = [userAddress, privacyKey, ...clientActions].map(toHex);
    executeCalldata = [
      '0x1',
      PRIVACY_POOL_ADDRESS,
      sel.getSelectorFromName('compile_and_panic'),
      '0x' + innerCalldata.length.toString(16),
      ...innerCalldata,
    ];
  } else if (approach === 'call-apply') {
    // Approach 3: Call to self with apply_actions (empty actions - just to test selector acceptance)
    console.log('Approach: Call to self with apply_actions');
    executeCalldata = [
      '0x1',
      PRIVACY_POOL_ADDRESS,
      sel.getSelectorFromName('apply_actions'),
      '0x1', // calldata len = 1
      '0x0', // empty actions
    ];
  } else {
    // Approach 4: Just the Call array with a different target
    console.log('Approach:', approach);
    executeCalldata = [userAddress, privacyKey, ...clientActions].map(toHex);
  }

  console.log('\nExecute calldata:', executeCalldata.length, 'felts');

  // Resource bounds for proving: all prices = 0
  const rb = {
    l1_gas: { max_amount: 0x0n, max_price_per_unit: 0x0n },
    l2_gas: { max_amount: 0x5F5E100n, max_price_per_unit: 0x0n },
    l1_data_gas: { max_amount: 0x0n, max_price_per_unit: 0x0n },
  };

  // The pool's __validate__ will check signature — we need to sign as the pool expects
  // But the pool's __validate__ might check the user's signature differently
  // Let's first try with empty signature to see what the pool's __validate__ expects
  const txHash = hash.calculateInvokeTransactionHash({
    senderAddress: PRIVACY_POOL_ADDRESS,
    version: '0x3',
    compiledCalldata: executeCalldata,
    chainId,
    nonce: toHex(poolNonce),
    accountDeploymentData: [],
    nonceDataAvailabilityMode: 0,
    feeDataAvailabilityMode: 0,
    paymasterData: [],
    resourceBounds: rb,
    tip: 0n,
  });
  console.log('TX hash:', txHash);

  // Sign with the user's ETH key (the pool's __validate__ should verify via is_valid_signature)
  const signature = await signStarknetHash(PK, txHash);
  console.log('Signature:', signature);

  // Send to proving service
  console.log('\nSending to prover (sender = privacy pool)...');
  const res = await fetch(PROVING_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'starknet_proveTransaction',
      params: {
        block_id: 'latest',
        transaction: {
          type: 'INVOKE',
          version: '0x3',
          sender_address: PRIVACY_POOL_ADDRESS,
          calldata: executeCalldata,
          signature,
          nonce: toHex(poolNonce),
          resource_bounds: {
            l1_gas: { max_amount: '0x0', max_price_per_unit: '0x0' },
            l2_gas: { max_amount: '0x5F5E100', max_price_per_unit: '0x0' },
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

  const data = await res.json();
  if (data.error) {
    console.log('\nERROR:', JSON.stringify(data.error, null, 2).slice(0, 1500));
  } else {
    console.log('\nSUCCESS!');
    console.log('Result keys:', Object.keys(data.result || {}));
    console.log('proof_facts:', data.result?.proof_facts?.length, 'elements');
    console.log('proof length:', data.result?.proof?.length, 'chars');
    console.log('l2_to_l1_messages:', data.result?.l2_to_l1_messages?.length, 'messages');
    console.log('\nFull result preview:', JSON.stringify(data.result).slice(0, 500));
  }
}

main().catch((e) => { console.error('FATAL:', e.message?.slice(0, 500)); process.exit(1); });
