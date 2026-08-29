# Web3 indexed backend

Indexer + read-only API for the Sepolia portfolio demo. The chain is the source
of truth; PostgreSQL is a rebuildable read model.

## Local development

```bash
cd backend
cp .env.example .env          # fill in SEPOLIA_RPC_URL
npm install
docker compose up -d postgres # creates web3_index_dev AND web3_index_test
npm run db:migrate            # migrate development
npm run db:test:migrate       # migrate the isolated test database
npm test
npm run indexer:sync
npm run api:dev
```

## Two databases

| Database | Variable | Purpose |
|---|---|---|
| `web3_index_dev` | `DATABASE_URL` | Local development index. The API, indexer and every dev command use this. **Tests never touch it.** |
| `web3_index_test` | `DATABASE_URL_TEST` | Disposable. Truncated and rebuilt on every test run. |

Both live in one local-only PostgreSQL service, created on first `docker compose
up` by `docker/init-databases.sql`.

Test code **never falls back to `DATABASE_URL`**. `src/db/test-guard.js` refuses
to run any test, migration or reset unless the target:

- is set as `DATABASE_URL_TEST`;
- differs from `DATABASE_URL` (including the same host/port/database reached
  with different credentials);
- has a name containing `_test`;
- is on `localhost`, `127.0.0.1` or `::1`.

The Docker Compose service name `postgres` is **not** allowed by default: it is
a hostname, not an address, so what it resolves to depends on the container
network. Permit it only from an explicit Docker/CI test environment by setting
**both** `NODE_ENV=test` and `TEST_DATABASE_ALLOW_COMPOSE_HOST=true`. Neither
belongs in a normal local `.env`.

Anything else aborts with the reason stated. `test/guard.test.js` covers each
rejection case.

If the databases ever need recreating from scratch:

```bash
docker compose down -v && docker compose up -d postgres
npm run db:migrate && npm run db:test:migrate && npm run indexer:sync
```

Then, from the repository root:

```bash
NEXT_PUBLIC_WEB3_API_URL=http://127.0.0.1:4000 npm run build && npm start
```

## Commands

| Command | Purpose |
|---|---|
| `npm run db:migrate` | Apply migrations to **development** |
| `npm run db:deploy` | Apply migrations (production) |
| `npm run db:test:migrate` | Apply migrations to the **test** database |
| `npm run db:test:reset` | Drop and recreate the **test** schema |
| `npm run db:test:status` | Migration status of the **test** database |
| `npm run indexer:sync` | One indexing pass |
| `npm run indexer:watch` | Long-running poll loop |
| `npm run indexer:status` | Cursor, counts and health |
| `npm run indexer:rebuild -- --confirm` | Wipe and re-index this factory |
| `npm run api:dev` | Start the API |
| `npm test` | Full backend suite |

## Endpoints

| Route | Returns |
|---|---|
| `GET /health` | Database, indexed vs chain block, lag, last sync, staleness |
| `GET /api/v1/web3/summary` | Factory, total held, participation breakdown |
| `GET /api/v1/web3/splits` | Every split with lifecycle state and evidence |
| `GET /api/v1/web3/splits/:address` | One split |
| `GET /api/v1/web3/activity` | Recent decoded events (`?limit=`, `?eventName=`) |
| `GET /api/v1/web3/questions` | Guided question list |
| `GET /api/v1/web3/intelligence/:questionId` | One grounded answer |

All GET. No write routes, no signer, no key material.

## Security

Participant addresses are stored in the raw index (needed to count outstanding
claims) but filtered at the API boundary by an allow-list of public argument
fields. No endpoint returns one — enforced by `test/api.test.js`.

See [DEPLOYMENT.md](DEPLOYMENT.md) for the production boundary between browser,
Vercel, VPS and database.
