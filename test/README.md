# E2E Integration Tests

End-to-end tests for SNIP-36 EVM accounts interacting with the Starknet privacy pool on Sepolia. Tests run daily in CI and can be triggered manually.

## Wallets

| Wallet | Private Key | Description |
|--------|------------|-------------|
| **A** | Hardhat #0 (`ac0974...`) | Primary account, pre-funded with STRK |
| **B** | Hardhat #1 (`59c699...`) | Second account, funded by A during setup |

Both use secp256k1 (EthAccount) with the `ETH_ACCOUNT_CLASS_HASH` contract.

## Test Scenarios

### 1. Setup (`npx tsx test/e2e.ts setup`)

Deploys both accounts on Sepolia.

- Wallet A: deploy via AVNU paymaster (sponsored)
- Wallet B: deploy via sponsor fallback (A funds B's counterfactual address with 5 STRK, then B self-deploys via `DEPLOY_ACCOUNT`)
- Skips deployment if the account is already deployed

### 2. Deposit (`npx tsx test/e2e.ts deposit`)

Wallet A deposits STRK into the privacy pool and creates a self-note.

**First run** (no self-channel yet):
```
SetViewingKey  ->  OpenChannel(self)  ->  Deposit(STRK)  ->  Withdraw(self)
```

**Subsequent runs** (self-channel already exists):
```
Deposit(STRK)  ->  CreateEncNote(self)
```

- `OpenChannel` is WriteOnce per recipient -- can only be opened once
- `CreateEncNote` provides replay protection via WriteOnce note storage
- Channel index and note index are discovered by scanning on-chain state
- Balance must net to zero: `Deposit(+X) + CreateEncNote(-X) = 0`

### 3. Private Transfer (`npx tsx test/e2e.ts transfer`)

Wallet A sends STRK privately to Wallet B via an encrypted note.

```
Fund B (if needed)  ->  Register B's viewing key  ->  Wait for block finality
->  OpenChannel(B)  ->  OpenSubchannel(B, STRK)  ->  Deposit(STRK)  ->  CreateEncNote(B)
```

- `CreateEncNote` creates an encrypted note only B can decrypt with its viewing key
- Unlike `Withdraw` (public recipient on-chain), `CreateEncNote` keeps the transfer private
- Requires B's Stark public key (from `get_public_key` on the pool contract)
- Channel key computed via Poseidon hash: `h(tag, sender, sender_key, recipient, recipient_pubkey)`
- Waits 25 blocks after state changes before proving (prover uses `latestBlock - 20`)

### 4. Withdraw (`npx tsx test/e2e.ts withdraw`)

Wallet A withdraws STRK from the privacy pool back to its own address.

```
Withdraw(self, STRK, amount)
```

## Privacy Pool Action Variants

| Index | Action | Fields | WriteOnce |
|-------|--------|--------|-----------|
| 0 | SetViewingKey | random | No |
| 1 | OpenChannel | recipient, index(u32), random, salt | Yes (channel_marker) |
| 2 | OpenSubchannel | recipient, pubkey, channel_key, index(u32), token, salt | Yes (subchannel_marker) |
| 3 | CreateEncNote | recipient, pubkey, token, amount(u128), index(u32), salt(u128 < 2^120) | Yes (note_id) |
| 5 | Deposit | token, amount(u128) | No |
| 7 | Withdraw | to_addr, token, amount(u128), random | No |

Every batch must include at least one WriteOnce action for replay protection, and all intermediate balances must net to zero.

## Pipeline

Each privacy pool operation follows this flow:

```
compile_actions (view call)  ->  prove (proving service)  ->  sign  ->  apply_actions (on-chain)
```

1. **compile_actions**: the pool contract compiles client actions into server actions (view call, no gas)
2. **prove**: the proving service re-executes the transaction at a historical block and generates a proof
3. **sign**: the user signs the on-chain transaction hash (which includes `proof_facts`)
4. **apply_actions**: submitted on-chain with the proof attached

## Environment Variables

| Variable | Description |
|----------|-------------|
| `VITE_STARKNET_RPC_URL` | Starknet Sepolia RPC endpoint |
| `VITE_AVNU_API_KEY` | AVNU paymaster API key |
| `VITE_AVNU_PAYMASTER_URL` | AVNU paymaster RPC endpoint |
| `VITE_PROVING_SERVICE_URL` | Privacy pool proving service endpoint |

## Running Locally

```bash
export VITE_STARKNET_RPC_URL=...
export VITE_AVNU_API_KEY=...
export VITE_AVNU_PAYMASTER_URL=...
export VITE_PROVING_SERVICE_URL=...

npx tsx test/e2e.ts setup
npx tsx test/e2e.ts deposit
npx tsx test/e2e.ts transfer
```

Or run all steps sequentially:

```bash
npx tsx test/e2e.ts all
```
