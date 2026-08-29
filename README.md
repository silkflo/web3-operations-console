# Web3 Operations Console

A read-only operations console for a set of **Sepolia testnet** smart contracts.
It shows what the deployed contracts actually hold and what has actually
happened to them, and links every figure to a block explorer so a reader can
check it independently.

**Live:** <https://web3.flo-portfolio.com> · **API:** <https://web3-api.flo-portfolio.com>

> ### Testnet demo — read this first
>
> - Everything runs on the **Sepolia test network**. Sepolia ETH has no monetary
>   value. Nothing here is a real payment, customer or revenue.
> - There is **no mainnet deployment**.
> - The contracts have **not** had a professional external audit. They have unit,
>   security, fuzz and invariant tests, which is not the same thing.
> - The console is **read-only**: no wallet connection, and no transaction is
>   ever signed or sent from the frontend or the API.
> - The "Contract Intelligence" answers are **deterministic rules over indexed
>   chain data**, not a language model. Each answer cites the events and reads it
>   was derived from.

---

## Live architecture

```
Sepolia                Indexer                PostgreSQL           API                Browser
┌──────────────┐       ┌──────────────┐       ┌──────────────┐     ┌───────────┐      ┌──────────────┐
│ SplitFactory │──────>│ eth_getLogs  │──────>│ read model   │────>│ Fastify   │─────>│ Next.js page │
│ EthSplit x3  │  logs │ + live reads │  rows │ (rebuildable)│     │ GET-only  │HTTPS │ (no ethers)  │
└──────────────┘       └──────────────┘       └──────────────┘     └───────────┘      └──────────────┘
        ^                                                                │
        └───────────────── live balance / state reads ───────────────────┘
```

- **The chain is the source of truth.** PostgreSQL is a cache of decoded history
  that can be dropped and rebuilt from Sepolia at any time.
- **Historical facts** (joins, funding, finalization, withdrawals) are served
  from the index. **Current state** (balances, participant counts, round) is read
  live from the contracts on each request and merged in.
- **The browser holds no chain credential.** It makes one kind of request: HTTPS
  GETs to the API base in `NEXT_PUBLIC_WEB3_API_URL`. It imports no `ethers`, no
  Prisma client and no database driver, and it never talks to an RPC node.
- Participant addresses are used server-side to count outstanding claims and are
  never included in an API response or in the generated frontend config.

## Deployed contracts (Sepolia)

|                         | Address                                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **SplitFactory** v3.0.0 | [`0xbddD01aE6B2899c507DD540E6437552006f008eA`](https://sepolia.etherscan.io/address/0xbddD01aE6B2899c507DD540E6437552006f008eA#code) |
| Deployment tx           | [`0x47b4b2c1…f793901`](https://sepolia.etherscan.io/tx/0x47b4b2c1547302523383c42ee2d010e603e1054523a7ee7024ad9fcb1f793901)           |

| Split                      | Address                                                                                                     | State                           |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Creator Revenue Share      | [`0x0B8a5aAA…06cf32`](https://sepolia.etherscan.io/address/0x0B8a5aAA27477dB7799e89b8a60266322406cf32#code) | funded, finalized, 1 withdrawal |
| Product Team Bonus         | [`0x36aCdDAc…61ef39`](https://sepolia.etherscan.io/address/0x36aCdDAc008630dB5e4BE3821D0776F88461ef39#code) | 4 joined, awaiting funding      |
| Project Partner Settlement | [`0xa017f14f…2E26D3`](https://sepolia.etherscan.io/address/0xa017f14f28CfC85AA0a61D505647C75c392E26D3#code) | 3 joined, awaiting funding      |

The committed manifest at
[`ethereum-v3/deployments/sepolia-demo-v1.json`](ethereum-v3/deployments/sepolia-demo-v1.json)
records every address, transaction hash and block number above, and is the single
source of truth for the frontend config and the indexer's start block.

`EthSplit` v3 divides each **funded round equally** among the participants of
that round. There is no weighted or percentage allocation. `finalizeDistribution()`
clears the participant list and increments the round, so a finalized split
correctly reports 0 _current_ participants — the console never presents that as
"nobody joined".

Re-check the whole environment against the chain, read-only:

```bash
cd ethereum-v3 && npm run verify:demo:sepolia
```

## Repository structure

```
.
├── pages/index.js            Console homepage (Pages Router)
├── pages/_app.js             Imports the single global stylesheet
├── components/Header.js      Portfolio navigation (plain cross-origin links)
├── styles/globals.css        The only global CSS
├── lib/
│   ├── web3-api-client.js    The browser's only route to Web3 data
│   └── contract-intelligence/  Pure rules shared by the API and the tests
├── backend/                  Fastify read-only API, indexer, Prisma schema
│   ├── src/api/              Routes, app, server
│   ├── src/indexer/          Log scan, reorg handling, projection
│   ├── prisma/               Schema and migrations
│   └── test/                 Node test runner suites
└── ethereum-v3/              Solidity, Hardhat, scripts, deployment manifest
    ├── contracts/            EthSplit.sol, SplitFactory.sol
    ├── deployments/          Public Sepolia manifest
    ├── frontend/             ABIs + generated demo-deployment.json
    └── test/                 unit, security, fuzz, invariant, demo
```

## Local setup

Requires Node 20+ and Docker (for the local PostgreSQL).

**Frontend**

```bash
npm install
npm run dev
```

`NEXT_PUBLIC_WEB3_API_URL` in `.env.local` is the only variable the browser
reads, and it is public configuration rather than a secret. Point it at a local
backend with `NEXT_PUBLIC_WEB3_API_URL=http://127.0.0.1:4000`. With it unset the
console still builds and renders, and reports the backend as unconfigured.

**Contracts**

```bash
cd ethereum-v3
npm install
npm test
```

**Backend**

```bash
cd backend
cp .env.example .env
npm install
docker compose up -d postgres
npm run db:migrate
npm run db:test:migrate
npm run indexer:sync
npm run api:dev
```

`docker compose up` creates both `web3_index_dev` and `web3_index_test`. Fill in
`SEPOLIA_RPC_URL` in `.env` before running the indexer; keep the local database
values as they ship.

See [`backend/README.md`](backend/README.md) for the endpoint list and the
two-database rule, and [`backend/DEPLOYMENT.md`](backend/DEPLOYMENT.md) for the
VPS deployment.

## Tests

| Command                  | Covers                                                                 |
| ------------------------ | ---------------------------------------------------------------------- |
| `npm run test:contracts` | Solidity unit, security (reentrancy), fuzz and invariant suites        |
| `npm run test:demo`      | Manifest schema, scenarios, workflow, console copy, intelligence rules |
| `npm run test:backend`   | Guard, architecture boundaries, Fastify compatibility, indexer, API    |

The backend suite needs the local PostgreSQL from `backend/docker-compose.yml`.
Suites that need a database skip themselves, with a stated reason, when
`DATABASE_URL_TEST` is not configured.

## Security boundaries

These are enforced by tests (`backend/test/boundaries.test.js`), not by
convention:

- No frontend file imports Prisma or a database client, or references
  `DATABASE_URL` or a connection string.
- No frontend file reads the server-only `SEPOLIA_RPC_URL`.
- The console page performs no `eth_getLogs` / `queryFilter` scan, constructs no
  RPC provider and does not bundle `ethers`.
- No signer, wallet, private key or mnemonic exists anywhere in backend or
  frontend code. The API is GET-only and never signs.
- No wallet connection: no `window.ethereum`, no `eth_requestAccounts`.
- `.env.example` files carry placeholders only; `.env` is gitignored everywhere.

Database credentials and the RPC URL live only on the VPS. They are never
configured in the frontend host and never reach the browser.

**Test-database isolation.** `backend/src/db/test-guard.js` refuses any test,
migration or reset whose target is not an explicitly configured, local,
`_test`-named database distinct from `DATABASE_URL`. Tests never fall back to
`DATABASE_URL`.

## Known limitations

- Sepolia only. There is no mainnet deployment and no plan for one.
- No professional external audit.
- The index is eventually consistent: the indexer waits for confirmations, so
  the console shows an explicit freshness state and marks data stale when the
  indexer falls behind the chain head.
- The demo participant wallets are controlled by the author. Their joins are
  real signed transactions, but they are not independent third parties.
- The API is a single VPS instance with per-IP rate limiting. It is not
  redundant and carries no uptime guarantee.
- The frontend is a single page. There is no routing, search or pagination
  beyond the activity `limit` parameter.
- Answers are fixed, deterministic explanations for five guided questions. There
  is no free-text input and no model inference.

## License

MIT — see [LICENSE](LICENSE).

## Author

Built by **Florian**.

[Portfolio](https://flo-portfolio.com/about) ·
[Projects](https://flo-portfolio.com/projects) ·
[Contact](https://flo-portfolio.com/contact)
