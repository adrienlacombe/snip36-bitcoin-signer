# SNIP-36 Privacy Pool

Privacy pool implementation for confidential STRK transfers on Starknet, using a Ledger Bitcoin hardware wallet as the signing mechanism.

## Overview

This project implements [SNIP-36](https://github.com/starknet-io/SNIPs/blob/main/SNIPS/snip-36.md) — a protocol for private transactions with zero-knowledge proof verification on Starknet. Users connect a Ledger device (Bitcoin app), deploy a Starknet account derived from their Bitcoin public key, and interact with a privacy pool for confidential deposits, withdrawals, and transfers.

### How It Works

1. **Connect** — User connects their Ledger with the Bitcoin app open. A secp256k1 public key is derived at BIP44 path `44'/0'/0'/0/{index}` and Poseidon-hashed to compute a Starknet account address.
2. **Deploy** — The account contract is deployed gaslessly via the AVNU paymaster.
3. **Fund** — User sends STRK to their account address.
4. **Interact** — Deposit into the privacy pool, withdraw with zk-proofs, or transfer between private notes.

### Viewing Key

A **viewing key** is required before any privacy pool operation (deposit, withdraw, transfer). It allows the discovery service to detect and decrypt private notes belonging to the user.

**Derivation** — The viewing key is derived deterministically from the Poseidon hash of the user's Bitcoin public key. The hash is reduced modulo half the Stark curve order to produce a valid scalar:

```
viewingKey = (poseidonHash(pubkey) mod (EC_ORDER / 2 - 1)) + 1
```

This means the viewing key is fully determined by the Ledger account — no extra secret to back up.

**Registration** — Before first use, the viewing key must be registered on-chain by calling the privacy pool's `set_public_key` entrypoint. This is done through the SDK with `autoRegister: true`, which builds a ZK proof and submits the registration transaction. The user signs twice on the Ledger (once for the proof, once for the on-chain submission).

**Discovery** — Once registered, the viewing key is passed to the Privacy SDK's `discoveryProvider`, which uses it to scan for and decrypt the user's private notes and compute their shielded balance.

**Timing constraint** — The proving service operates on a block that lags behind the chain tip (~10 blocks). After deploying an account or registering a viewing key, state changes need approximately 70 minutes (~420 blocks) to become visible to the prover.

## Project Structure

```
├── src/                  # React frontend
│   ├── components/       # UI components (PrivacyActions, FundingPanel, layout, shared)
│   ├── hooks/            # useLedger — Ledger + account state management
│   ├── lib/              # LedgerBitcoinSigner, WebHID transport
│   └── config/           # Environment constants
├── contracts/            # Cairo smart contracts (Scarb, Cairo 2.15.0)
│   └── src/
│       ├── account.cairo             # Account contract interface
│       ├── signer/bitcoin.cairo      # Bitcoin signature verification
│       └── multiowner_account/       # Multi-owner account logic
└── test/                 # E2E tests (TypeScript)
```

## Prerequisites

- [Node.js](https://nodejs.org/) (v20+)
- [Ledger](https://www.ledger.com/) hardware wallet with the Bitcoin app installed
- [Scarb](https://docs.swmansion.com/scarb/) 2.15.0 (for contract development)
- [snforge](https://foundry-rs.github.io/starknet-foundry/) 0.38.3 (for contract testing)

## Setup

```bash
# Install dependencies
npm install

# Copy and fill in environment variables
cp .env.example .env
```

### Environment Variables


| Variable                     | Description                    |
| ---------------------------- | ------------------------------ |
| `VITE_AVNU_API_KEY`          | AVNU paymaster API key         |
| `VITE_AVNU_PAYMASTER_URL`    | AVNU paymaster endpoint        |
| `VITE_STARKNET_RPC_URL`      | Starknet JSON-RPC URL          |
| `VITE_DISCOVERY_SERVICE_URL` | Private note discovery service |
| `VITE_PROVING_SERVICE_URL`   | ZK proving service endpoint    |


## Development

```bash
# Start the dev server
npm run dev

# Build for production
npm run build

# Lint
npm run lint
```

## Testing

```bash
# Run the full E2E flow
npm run test:all

# Or run individual phases
npm run test:setup      # Deploy account
npm run test:deposit    # Deposit into privacy pool
npm run test:withdraw   # Withdraw from privacy pool
```

## Contracts

```bash
cd contracts

# Build Cairo contracts
scarb build

# Run tests
snforge test
```

## Tech Stack

- **Frontend**: React 19, TypeScript, Vite, Tailwind CSS
- **Starknet**: starknet.js (PRIVACY fork), Starknet Privacy SDK
- **Ledger**: `@ledgerhq/hw-app-btc`, WebHID transport
- **Crypto**: `@noble/secp256k1`, `@noble/hashes`, Poseidon hashing
- **Contracts**: Cairo 2.15.0, OpenZeppelin, Argent account contracts (fork)

