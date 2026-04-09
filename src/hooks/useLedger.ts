import { useState, useCallback } from 'react';
import { RpcProvider, Account, constants } from 'starknet';
import { createPrivateTransfers, type PrivateTransfersInterface } from '@starkware-libs/starknet-privacy-sdk';
import { getBtcPublicKey, disconnectLedger } from '../lib/ledger';
import { pubkeyToPoseidonHash, calculateAccountAddress, LedgerBitcoinSigner } from '../lib/signer';
import {
  ACCOUNT_CLASS_HASH, STARKNET_RPC_URL, STRK_TOKEN_ADDRESS,
  AVNU_PAYMASTER_URL, AVNU_API_KEY, PRIVACY_POOL_ADDRESS,
  PROVING_SERVICE_URL, DISCOVERY_SERVICE_URL,
} from '../config/constants';

export interface LedgerState {
  connected: boolean;
  pubkeyHash: string | null;
  starknetAddress: string | null;
  deployed: boolean;
  balance: bigint;
  signer: LedgerBitcoinSigner | null;
  account: Account | null;
  transfers: PrivateTransfersInterface | null;
  viewingKeySet: boolean;
  error: string | null;
  loading: string | null; // current loading operation
}

// Viewing key — deterministic from pubkey_hash for simplicity
const EC_ORDER = 0x0800000000000010ffffffffffffffffb781126dcae7b2321e66a241adc64d2fn;
function deriveViewingKey(pubkeyHash: string): bigint {
  const seed = BigInt(pubkeyHash);
  return (seed % (EC_ORDER / 2n - 1n)) + 1n;
}

export function useLedger() {
  const [state, setState] = useState<LedgerState>({
    connected: false, pubkeyHash: null, starknetAddress: null,
    deployed: false, balance: 0n, signer: null, account: null,
    transfers: null, viewingKeySet: false, error: null, loading: null,
  });

  const provider = new RpcProvider({ nodeUrl: STARKNET_RPC_URL });

  const connect = useCallback(async (accountIndex: number = 0) => {
    setState(s => ({ ...s, loading: 'Connecting to Ledger...', error: null }));
    try {
      const { publicKey } = await getBtcPublicKey(accountIndex);
      const pubkeyHash = pubkeyToPoseidonHash(publicKey);
      const starknetAddress = calculateAccountAddress(pubkeyHash, ACCOUNT_CLASS_HASH);
      const signer = new LedgerBitcoinSigner(pubkeyHash, accountIndex);
      const account = new Account({ provider, address: starknetAddress, signer, cairoVersion: '1' });

      // Check deployment
      let deployed = false;
      try { await provider.getClassHashAt(starknetAddress); deployed = true; } catch {}

      // Check balance
      let balance = 0n;
      if (deployed) {
        const r = await provider.callContract({ contractAddress: STRK_TOKEN_ADDRESS, entrypoint: 'balanceOf', calldata: [starknetAddress] });
        balance = BigInt(r[0]) + (BigInt(r[1]) << 128n);
      }

      // Check viewing key
      let viewingKeySet = false;
      if (deployed) {
        try {
          const r = await provider.callContract({ contractAddress: PRIVACY_POOL_ADDRESS, entrypoint: 'get_public_key', calldata: [starknetAddress] });
          viewingKeySet = r[0] !== '0x0' && r[0] !== '0';
        } catch {}
      }

      // Init SDK
      const viewingKey = deriveViewingKey(pubkeyHash);
      const transfers = createPrivateTransfers({
        account,
        viewingKeyProvider: { getViewingKey: async () => viewingKey },
        provingProvider: { url: PROVING_SERVICE_URL, chainId: constants.StarknetChainId.SN_SEPOLIA },
        discoveryProvider: { url: DISCOVERY_SERVICE_URL },
        poolContractAddress: PRIVACY_POOL_ADDRESS,
      });

      setState({
        connected: true, pubkeyHash, starknetAddress, deployed, balance,
        signer, account, transfers, viewingKeySet, error: null, loading: null,
      });
    } catch (e) {
      setState(s => ({ ...s, loading: null, error: e instanceof Error ? e.message : String(e) }));
    }
  }, []);

  const deploy = useCallback(async () => {
    if (!state.pubkeyHash || !state.starknetAddress) return;
    setState(s => ({ ...s, loading: 'Deploying account via AVNU...' }));
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (AVNU_API_KEY) headers['x-paymaster-api-key'] = AVNU_API_KEY;

      const toHex = (v: string) => v.startsWith('0x') ? v : '0x' + BigInt(v).toString(16);
      const res = await fetch(AVNU_PAYMASTER_URL, {
        method: 'POST', headers,
        body: JSON.stringify({
          jsonrpc: '2.0', method: 'paymaster_executeTransaction',
          params: {
            transaction: { type: 'deploy', deployment: {
              address: state.starknetAddress, class_hash: ACCOUNT_CLASS_HASH,
              salt: state.pubkeyHash,
              calldata: ['0x2', toHex(state.pubkeyHash), '0x1'],
              version: 1,
            }},
            parameters: { version: '0x1', fee_mode: { mode: 'sponsored' } },
          }, id: 1,
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      await provider.waitForTransaction(data.result.transaction_hash);
      setState(s => ({ ...s, deployed: true, loading: null }));
    } catch (e) {
      setState(s => ({ ...s, loading: null, error: e instanceof Error ? e.message : String(e) }));
    }
  }, [state.pubkeyHash, state.starknetAddress]);

  const refreshBalance = useCallback(async () => {
    if (!state.starknetAddress) return;
    const r = await provider.callContract({ contractAddress: STRK_TOKEN_ADDRESS, entrypoint: 'balanceOf', calldata: [state.starknetAddress] });
    setState(s => ({ ...s, balance: BigInt(r[0]) + (BigInt(r[1]) << 128n) }));
  }, [state.starknetAddress]);

  const disconnect = useCallback(async () => {
    await disconnectLedger();
    setState({
      connected: false, pubkeyHash: null, starknetAddress: null,
      deployed: false, balance: 0n, signer: null, account: null,
      transfers: null, viewingKeySet: false, error: null, loading: null,
    });
  }, []);

  return { ...state, connect, deploy, refreshBalance, disconnect, provider };
}
