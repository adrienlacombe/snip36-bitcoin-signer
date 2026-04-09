/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AVNU_API_KEY: string;
  readonly VITE_STARKNET_RPC_URL: string;
  readonly VITE_DISCOVERY_SERVICE_URL: string;
  readonly VITE_PROVING_SERVICE_URL: string;
  readonly VITE_WC_PROJECT_ID: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
