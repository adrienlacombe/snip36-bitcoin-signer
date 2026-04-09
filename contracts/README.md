# casawybla Contracts

Fork of [Argent v0.5.0](https://github.com/argentlabs/argent-contracts-starknet) with an added **Bitcoin signer** variant. The Bitcoin signer verifies secp256k1 signatures wrapped with the Bitcoin message prefix (`\x18Bitcoin Signed Message:\n` + double SHA-256), enabling Ledger Bitcoin app support for Starknet accounts.

## Requirements

| Tool | Required version |
|------|-----------------|
| Scarb | **2.10.1** (Cairo 2.10.1) |
| snforge | **0.38.3** |

> **The project pins Cairo 2.10.1.** Building or testing with a newer Scarb (e.g. 2.15+) will fail due to dependency incompatibilities in `alexandria_data_structures`.

### Managing Scarb versions with asdf

```bash
# Install the required version (one-time)
asdf install scarb 2.10.1

# Pin it for this directory
asdf set scarb 2.10.1
```

If the asdf shim doesn't resolve correctly, invoke the binary directly:

```bash
$(asdf where scarb 2.10.1)/bin/scarb build
```

### Installing snforge 0.38.3

```bash
snfoundryup --version 0.38.3
```

## Build

```bash
scarb build
```

## Test

```bash
# Run all Cairo unit tests
snforge test

# Run only the Bitcoin signer tests
snforge test bitcoin
```

If your default Scarb is a different version, prefix with:

```bash
SCARB=$(asdf where scarb 2.10.1)/bin/scarb snforge test
```

## Declare on Sepolia

```bash
sncast --account casawybla-deployer declare --contract-name ArgentAccount
```

The declared class hash goes into `webapp/src/lib/constants.ts` as `ACCOUNT_CLASS_HASH`.
