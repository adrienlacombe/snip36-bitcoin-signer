// Modified casawybla account: Bitcoin signer with Poseidon (no keccak)
export const ACCOUNT_CLASS_HASH =
  '0x547b1790e63a72b6a48c18055ae37cfe4191ae8a6980472b4546f07984d2386';

export const PRIVACY_POOL_ADDRESS =
  '0x254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91';

export const STRK_TOKEN_ADDRESS =
  '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';

export const STARKNET_RPC_URL = import.meta.env.VITE_STARKNET_RPC_URL || '';
export const AVNU_PAYMASTER_URL = import.meta.env.VITE_AVNU_PAYMASTER_URL || '';
export const AVNU_API_KEY = import.meta.env.VITE_AVNU_API_KEY || '';
export const PROVING_SERVICE_URL = import.meta.env.VITE_PROVING_SERVICE_URL || '';
export const DISCOVERY_SERVICE_URL = import.meta.env.VITE_DISCOVERY_SERVICE_URL || '';

export const STARKNET_SEPOLIA_EXPLORER = 'https://sepolia.voyager.online';

// BIP44 derivation path for Bitcoin mainnet (Ledger Bitcoin app)
export function getBtcDerivationPath(accountIndex: number): string {
  return `44'/0'/0'/0/${accountIndex}`;
}
