# Demo Funding Plan

What a **worthwhile** portfolio demo environment requires, and what it costs.

> **Sepolia testnet only.** Every figure below is Sepolia test ETH, which has no
> monetary value and is obtained free from a faucet. No mainnet deployment is
> planned or permitted by these scripts.

---

## Why this document exists

Milestone 1 was built and then deliberately **not deployed**.

The "demo-lite" version — a clean factory plus three splits with no participants
and no activity — would have cost ~0.0092 ETH to produce three permanently empty
contracts. That is a poor trade: it spends most of a small test-ETH balance to
show a dashboard reading zeros, which demonstrates less than the existing
contract test suite already does.

This document specifies the minimum version that is actually worth deploying.

## Current state — DEPLOYED

This plan has been executed. The environment is live on Sepolia:

| | |
|---|---|
| Factory | [`0xbddD01aE6B2899c507DD540E6437552006f008eA`](https://sepolia.etherscan.io/address/0xbddD01aE6B2899c507DD540E6437552006f008eA) (verified) |
| Deployed | block 11,585,248 |
| Splits | 3, with 10 real participant joins |
| Actual spend | 0.011806 ETH |

Re-verify at any time, read-only:

```bash
cd ethereum-v3 && npm run verify:demo:sepolia
```

The cost analysis below is retained as the record of what was planned, and as
the method for pricing any future redeployment.

---

## The minimum proper deployment

Six things, in order. Anything less is not worth the test ETH.

### 1. Clean factory

One fresh `SplitFactory` (v3.0.0) on Sepolia, deployed via
`npm run deploy:demo:sepolia`, recorded in a committed manifest and verified on
Etherscan. It replaces the two throwaway *"V3 Demo Split"* fixtures as the
factory the dashboard reads. Those fixtures stay on-chain; they are simply no
longer active.

### 2. Three equal-split scenarios

| Scenario | Participants | Equal share |
|---|---|---|
| Creator Revenue Share | 3 | 33.33% |
| Product Team Bonus | 4 | 25.00% |
| Project Partner Settlement | 3 | 33.33% |

Equal, because `EthSplit` V3 divides a round strictly by participant count and
has no weighted allocation. Weighted splits would be a contract change.

### 3. Real participant joins from controlled demo wallets

This is the step that turns the demo from empty scaffolding into something worth
showing, and it is the one demo-lite skipped.

`EthSplit.join()` is `msg.sender`-based and the manager is barred from joining,
so each participant must sign its own transaction. That requires **wallets we
control and can fund** — four of them, reused across the three scenarios (the
pool only needs to be as large as the largest scenario).

**Prerequisite:** a dedicated testnet mnemonic in `.env` as `DEMO_MNEMONIC`,
gitignored, used for nothing else. Only derived public addresses are ever
committed; the phrase and keys are never printed or logged.

Done: the dashboard now shows real, Etherscan-verifiable participant counts.

### 4. One tiny funded and finalized split

*Creator Revenue Share* gets funded with **0.001 ETH** and finalized. This
exercises the parts of the contract that actually matter:

- `fund()` — manager deposits into the round pool;
- `finalizeDistribution()` — equal allocation, round increments to 2,
  participants must rejoin for the next round;
- the resulting `claimable` balances, visible on the dashboard.

0.001 ETH across 3 participants is 0.000333 ETH each — enough to be real,
small enough to be irrelevant.

### 5. One withdrawal

One participant calls `withdraw()`, demonstrating the pull-payment pattern and
the reentrancy-guarded path end to end. The dashboard then shows one split with
a partially claimed balance.

The result is three splits in genuinely different states: one funded, finalized
and partly withdrawn; and two with participants awaiting funding. That is a demo
worth linking to.

### 6. Clear Sepolia testnet labelling

Already implemented and unchanged by this plan:

- `Sepolia Testnet · Portfolio Demo` in the page header;
- testnet-only statements in the README and contract NatSpec;
- no production, audit, security or real-money claims anywhere;
- participant counts always read live from the contract, never from a static
  list; participant addresses never enter the browser bundle.

---

## Cost

Measured exactly by running the full lifecycle on a local EVM, priced at the
live Sepolia `maxFeePerGas` ceiling. Reproduce with:

```bash
cd ethereum-v3 && npm run estimate:lifecycle
```

At a **2.12 gwei** ceiling, 21 transactions, 5,368,985 gas total:

| Item | Gas | Cost (ETH) |
|---|---|---|
| Factory deployment | 1,556,568 | 0.003304 |
| 3 × `createSplit` | 2,604,549 | 0.005377 |
| 4 × gas-float transfer | 84,000 | 0.000178 |
| `fund` (0.001 ETH) | 47,881 | 0.000093 |
| `finalizeDistribution` | 131,971 | 0.000257 |
| **Deployer-paid gas subtotal** | | **0.008614** |
| 10 × participant `join` | 1,286,440 | 0.001764 |
| 1 × participant `withdraw` | 37,576 | 0.000073 |
| *(participant gas — paid out of the floats, not additional)* | | *0.001838* |

**ETH leaving the deployer wallet:**

| | ETH |
|---|---|
| Deployer-paid gas | 0.008614 |
| Gas floats to 4 demo wallets | 0.002756 |
| ETH funded into the demo round | 0.001000 |
| **Subtotal** | **0.012370** |
| Safety buffer (30%, gas drift mid-run) | 0.003711 |
| **Total spend required** | **0.016081** |

Float sizing is per wallet, from that wallet's own measured gas × 1.5. Wallet 1
joins all three scenarios and withdraws, so it needs roughly five times wallet
4's float; a flat figure would either strand test ETH or run one wallet dry
mid-seed.

### Wallet requirement

| | ETH |
|---|---|
| Total spend required | 0.016081 |
| Required reserve remaining (enforced gate) | 0.010000 |
| **Balance needed before starting** | **0.026081** |
| Current deployer balance | 0.029023 |
| **Surplus** | **0.002942** |

**The proper lifecycle was affordable at the current balance**, with ~0.0029 ETH
of projected headroom — where demo-lite would have spent 0.0092 ETH on three
empty contracts and left far less.

### Actual outcome

The run came in **27% under the estimate**, because the 30% safety buffer was
not needed and gas stayed near the base fee rather than the ceiling:

| | Estimated | Actual |
|---|---|---|
| Spend from deployer | 0.016081 | **0.011806** |
| Balance after | 0.012942 | **0.017217** |

A further 0.005347 ETH sits in the four demo wallets as unspent gas float. It is
recoverable — those wallets are derived from `DEMO_MNEMONIC` — but is best left
in place so the demo can be extended (a second round, more withdrawals) without
another funding pass.

---

## The pre-deployment gate

`scripts/lib/budget.js` enforces two conditions before any script broadcasts.
Both must hold:

1. worst-case spend stays under `BUDGET_ETH` (0.020);
2. worst-case spend leaves at least `MIN_REMAINING_ETH` (**0.010**) in the
   deployer wallet.

Condition 2 exists so a run can never drain the wallet to the point where a
retry or a follow-up milestone needs a faucet trip. Both are printed in every
estimate and dry-run.

`BUDGET_ETH` was raised from `0.010` to `0.020` to authorise this deployment —
a deliberate, reviewed one-line change. `MIN_REMAINING_ETH` was deliberately
**not** raised with it: the reserve floor is what stops a run draining the
wallet, and it stays at `0.010`.

The lifecycle runs as three separately gated phases (deploy, seed, lifecycle),
each of which must independently satisfy both conditions. Every phase passed
with headroom.

---

## Execution record

Run in this order, each phase gated independently:

1. `npm run estimate:lifecycle` — priced the plan, both gates passed
2. `npm run deploy:demo:sepolia` — factory at `0xbddD01aE...`, block 11,585,248
3. `npm run seed:demo:sepolia` — 3 splits created, 10 participant joins
4. `npm run lifecycle:demo:sepolia` — funded 0.001 ETH, finalized, 1 withdrawal
5. `npm run sync:frontend` — regenerated `demo-deployment.json`
6. `npm run verify:demo:sepolia` — every value re-read from chain, all passed

`DEMO_MNEMONIC` lives only in the gitignored `.env`. Only derived public
addresses appear in the manifest.
