# Portfolio Demo Environment

The Web3 AI Console on the portfolio site reads live data from a dedicated
**Sepolia testnet** deployment of the V3 contracts. This document covers how
that environment is deployed, seeded, recorded and consumed by the frontend.

> **Sepolia testnet only.** No mainnet deployment exists. Every address and
> transaction described here uses Sepolia test ETH, which has no monetary value.
> Nothing here is a real customer, a real payment, or real revenue. The
> contracts have not received a professional external audit.

---

## Live environment

| | |
|---|---|
| Factory | [`0xbddD01aE6B2899c507DD540E6437552006f008eA`](https://sepolia.etherscan.io/address/0xbddD01aE6B2899c507DD540E6437552006f008eA) |
| Version | 3.0.0, verified on Etherscan |
| Deployed | block 11,585,248 |
| Splits | 3, with 10 real participant joins |

| Scenario | Address | State |
|---|---|---|
| Creator Revenue Share | [`0x0B8a5aAA...`](https://sepolia.etherscan.io/address/0x0B8a5aAA27477dB7799e89b8a60266322406cf32) | funded, finalized, 1 withdrawal |
| Product Team Bonus | [`0x36aCdDAc...`](https://sepolia.etherscan.io/address/0x36aCdDAc008630dB5e4BE3821D0776F88461ef39) | 4 joined, awaiting funding |
| Project Partner Settlement | [`0xa017f14f...`](https://sepolia.etherscan.io/address/0xa017f14f28CfC85AA0a61D505647C75c392E26D3) | 3 joined, awaiting funding |

Re-verify everything against the chain at any time, read-only:

```bash
cd ethereum-v3 && npm run verify:demo:sepolia
```

### Participants

Participants are real: each of the 10 joins is a transaction signed by the
participant's own wallet, because `EthSplit.join()` is `msg.sender`-based and
the manager is barred from joining. The wallets derive from `DEMO_MNEMONIC`,
which lives only in the gitignored `.env`. Only derived public addresses reach
the manifest.

**Participant counts must always be read from the contract, never from a static
list.** The generated `frontend/demo-deployment.json` deliberately omits
participant addresses for exactly that reason, and a test enforces it.

### Why Creator Revenue Share shows 0 participants

`finalizeDistribution()` clears `participantsList`, resets `participantCount` to
0 and increments `round`. A finalized split therefore reports **0 current
participants and round 2**, even though three addresses joined and two still
hold claimable balances. Participants must rejoin for each new round — that is
the contract working as designed, not a dashboard fault.

### Allocation model

`EthSplit` V3 divides each funded round **equally**:

```solidity
uint256 amountPerParticipant = roundPool / count;
```

There are **no per-participant weights, percentages, or custom allocations** in
the contract. A four-person split is always 25% each. The manifest records
`allocation.model: "equal"` for every scenario, and the validator rejects any
split claiming a weighted model.

Weighted allocation would be a contract change — a new `EthSplit` version with
its own tests and deployment — not a seeding or frontend change.

## What is deployed

| Contract | Version | Role |
|---|---|---|
| `SplitFactory` | 3.0.0 | Deploys and indexes `EthSplit` instances |
| `EthSplit` | 3.0.0 | One split: participants, funding rounds, pull-payment withdrawals |

---

## Environment variables

All secrets live in `ethereum-v3/.env`, which is gitignored. Copy
`.env.example` and fill it in — the example contains placeholders only.

| Variable | Purpose |
|---|---|
| `SEPOLIA_RPC_URL` | Sepolia JSON-RPC endpoint used for deploying and seeding |
| `DEPLOYER_PRIVATE_KEY` | Testnet deployer. **Never a wallet holding real funds.** |
| `ETHERSCAN_API_KEY` | Contract verification |
| `DEMO_MNEMONIC` | BIP-39 phrase the controlled participant wallets derive from. **Testnet only, never committed, never printed.** |
| `NEXT_PUBLIC_SEPOLIA_RPC_URL` | Optional. Overrides the public read-only RPC the browser uses. |

The deployer needs Sepolia test ETH. The full lifecycle cost **0.011806 ETH** in
practice, against a 0.016081 ETH worst-case estimate. Faucets:
[sepoliafaucet.com](https://sepoliafaucet.com),
[Google Cloud faucet](https://cloud.google.com/application/web3/faucet/ethereum/sepolia).

---

## The budget gate

Every script that can spend prices its work **before** broadcasting:

- gas is estimated per transaction;
- priced at `maxFeePerGas`, the EIP-1559 ceiling a transaction can actually pay,
  not the current base fee;
- compared against a hard budget of **0.020 ETH** (`BUDGET_ETH`) and a
  **0.010 ETH** floor that must remain in the wallet afterwards
  (`MIN_REMAINING_ETH`), both in `scripts/lib/budget.js`;
- printed as a transaction-by-transaction table with the resulting balance.

If the worst case exceeds the budget, exceeds the deployer balance, **or** would
leave less than the reserve floor, the script aborts before broadcasting and
prints the cheapest alternatives. Deploy, seed and lifecycle are gated
independently, so no single phase can drain the wallet.

---

## Commands

Run everything from `ethereum-v3/`.

### 1. Estimate — costs nothing, broadcasts nothing

```bash
npm run estimate:demo        # factory + createSplit only
npm run estimate:lifecycle   # the full lifecycle, including joins and funding
```

Measures exact gas by running the workflow on the local EVM, prices it with live
Sepolia fee data, and prints the cost table. Run this first, every time.

### 2. Deploy the clean factory

```bash
npm run deploy:demo:sepolia:dry    # price it, broadcast nothing
npm run deploy:demo:sepolia
```

The script:

1. **Refuses any network that is not Sepolia.** It checks the live `chainId`
   from the RPC, not just the Hardhat network name, so a misconfigured
   `SEPOLIA_RPC_URL` pointing at another chain cannot slip through.
2. Prices the deployment and aborts if it breaks the budget.
3. Deploys a fresh `SplitFactory` and waits for 2 confirmations.
4. **Archives** any existing manifest to
   `sepolia-demo-v1.superseded-<timestamp>.json` rather than overwriting it —
   deployment records describe immutable on-chain history and are never
   destroyed.
5. Writes the new manifest and prints address, tx hash, block and Etherscan URLs.
6. Attempts Etherscan verification (failure is a warning, not fatal — verify
   manually with `npx hardhat verify --network sepolia <address>`).

### 3. Seed the scenarios

```bash
npm run seed:demo:sepolia:dry      # price it, print the plan, broadcast nothing
npm run seed:demo:sepolia
```

Creates each split and has the controlled wallets join it. The deployer sends
each wallet a gas float first, so a join can never fail for gas.

| Scenario | Participants | Equal share |
|---|---|---|
| Creator Revenue Share | 3 | 33.33% |
| Product Team Bonus | 4 | 25.00% |
| Project Partner Settlement | 3 | 33.33% |

**Duplicate protection:** the manifest is the ledger. Any scenario whose `key`
already appears in `manifest.splits` is skipped, and each is written the moment
it completes, so an interrupted run resumes instead of double-creating. Joins
additionally re-check `isParticipant` on the contract, so a resumed run cannot
revert with `AlreadyJoined`. Running the seed script twice is a no-op.

### 4. Run the lifecycle

```bash
npm run lifecycle:demo:sepolia:dry
npm run lifecycle:demo:sepolia
```

Funds *Creator Revenue Share* with 0.001 ETH, finalizes the round, and has one
participant withdraw. Every step is re-checked against the contract before it is
sent — funding is skipped if the pool already holds the target, finalization if
the round already advanced, a withdrawal if that participant's claimable is
already zero — so re-running is a no-op once complete.

### 5. Sync the frontend

```bash
npm run sync:frontend        # regenerate frontend/demo-deployment.json
npm run verify:demo          # fail if it is out of sync with the manifest
```

### 6. Verify and test

```bash
npm run verify:demo:sepolia  # re-read every value from the chain, read-only
npm test                     # full suite
npm run test:demo            # demo workflow only
```

---

## How the frontend selects the active factory

There is exactly one path from chain to page, and no step in it is hand-edited:

```
deployments/sepolia-demo-v1.json      <- written by deploy-demo.js + seed-demo.js
        |
        |  npm run sync:frontend
        v
frontend/demo-deployment.json         <- generated; do not edit
        |
        |  import
        v
frontend/config.js                    <- exports FACTORY_ADDRESS, chain id, RPC, label
        |
        |  import
        v
pages/index.js                        <- no hardcoded addresses
```

`frontend/config.js` is the only module a page may import Web3 configuration
from. A test in `test/demo/Workflow.test.js` fails if a factory address is ever
hardcoded back into a page component.

Before the first deployment, `demo-deployment.json` carries
`factoryAddress: null`; the dashboard detects this via `IS_DEMO_DEPLOYED` and
shows "Demo environment not deployed" instead of failing on a null address.

The console displays **`Sepolia Testnet · Portfolio Demo`** in the page header so
the environment is never ambiguous to a visitor.

---

## Verifying on Etherscan

Every address and transaction hash in the manifest is independently checkable —
the manifest also stores ready-made `explorer` URLs.

1. **Factory** — open `explorer.factory`. Confirm the contract exists, is
   verified, and that `getFactoryInfo()` returns version `3.0.0` and a split
   count of 3.
2. **Deployment transaction** — open `explorer.deploymentTx`. Confirm the
   deployer address and block number match the manifest.
3. **Each split** — open `splits[].explorer.split`. The *Events* tab shows the
   real lifecycle: `ParticipantJoined` for every join, plus `Funded`,
   `DistributionFinalized` and `Withdrawal` on Creator Revenue Share.
4. **Cross-check the dashboard** — titles, participant counts and balances must
   match Etherscan. The finalized split correctly shows round 2 and 0 current
   participants.

Or run all of the above automatically: `npm run verify:demo:sepolia`.

---

## The previous fixtures

An earlier V3 factory at
[`0xe8c19124799bd4C2114966689F606a254D683D5d`](https://sepolia.etherscan.io/address/0xe8c19124799bd4C2114966689F606a254D683D5d)
holds two development fixtures both titled *"V3 Demo Split"*.

**Those records remain on-chain and are not being hidden, deleted or disowned** —
they cannot be, and should not be. They are simply no longer the active demo
environment: they were throwaway fixtures created while wiring up the contracts,
not curated portfolio scenarios. The clean factory replaces them as what the
dashboard reads, and this file documents the change rather than papering over it.

Nothing in this workflow deletes a deployment record.
