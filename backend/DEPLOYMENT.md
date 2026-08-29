# Production deployment — VPS + Vercel

**Nothing in this document has been executed.** No VPS, DNS, Nginx, Caddy, PM2,
Docker host, Vercel setting or production secret was configured during this
milestone. These are the steps for when you choose to deploy.

---

## Architecture

```
                    ┌──────────────────────────────────────────┐
   Sepolia RPC ───► │  VPS (private)                           │
                    │                                          │
                    │   indexer ──► PostgreSQL ◄── Fastify API  │
                    │   (long-running)  (localhost only)   │    │
                    └──────────────────────────────────────┼───┘
                                                           │ HTTPS
                                                  ┌────────▼────────┐
                                                  │ Nginx / Caddy   │
                                                  │ web3-api.…      │
                                                  └────────┬────────┘
                                                           │ HTTPS
                                        ┌──────────────────▼─────────┐
                                        │ Vercel — Next.js frontend  │
                                        └──────────────────┬─────────┘
                                                           │ HTTPS
                                                    visitor browser
```

## Security boundary

| Layer      | May reach                              | Must never hold                                   |
| ---------- | -------------------------------------- | ------------------------------------------------- |
| Browser    | The public HTTPS API only              | Database URL, RPC secret, any key                 |
| Vercel     | `NEXT_PUBLIC_WEB3_API_URL` only        | `DATABASE_URL`, RPC secret, mnemonic, private key |
| VPS API    | PostgreSQL over localhost, Sepolia RPC | Nothing that can sign a transaction               |
| PostgreSQL | Nothing outbound                       | Must not be reachable from the internet           |

The API is read-only: GET routes only, no signer, no wallet, no key material.
Enforced by tests in `backend/test/boundaries.test.js` and `api.test.js`.

---

## 1. PostgreSQL

Bind to localhost or a private Docker network. Never publish 5432.

```bash
# docker-compose.prod.yml — note the 127.0.0.1 prefix
ports:
  - "127.0.0.1:5432:5432"
```

Confirm from outside the box that the port is closed:

```bash
nc -zv YOUR_VPS_IP 5432   # must fail
```

Create a dedicated role for the application rather than reusing `postgres`.

## 2. Migrations

Use `migrate deploy` in production — never `migrate dev`, which can prompt and
can reset.

```bash
cd backend && npx prisma migrate deploy
```

### Test commands must never exist in production

`DATABASE_URL_TEST` is a **local development concept only**. Never set it on a
production host, and never point it at production credentials.

The `db:test:*` commands are destructive by design — `db:test:reset` drops and
recreates the schema. They refuse to run unless the target is a local database
whose name contains `_test` and which differs from `DATABASE_URL`
(`src/db/test-guard.js`). That guard is a safety net, not a licence: production
deploys should run `db:deploy` and nothing else.

A production CI run must use its own disposable database. It must never reuse
production credentials, and it must never point `DATABASE_URL_TEST` at the
production host — the guard blocks the latter outright, since only localhost,
127.0.0.1, ::1 and the `postgres` compose service are approved.

## 3. Indexer as a managed process

Run `npm run indexer:watch` under a supervisor with automatic restart. systemd:

```ini
# /etc/systemd/system/web3-indexer.service
[Unit]
Description=Sepolia portfolio demo indexer
After=network-online.target postgresql.service

[Service]
Type=simple
User=web3
WorkingDirectory=/srv/flo-portfolio/backend
EnvironmentFile=/srv/flo-portfolio/backend/.env
ExecStart=/usr/bin/npm run indexer:watch
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

The indexer is restart-safe: it resumes from the stored checkpoint and the
unique key on `(chainId, transactionHash, logIndex)` makes replayed logs a
no-op, so an abrupt restart cannot duplicate or skip events.

## 4. API behind HTTPS

```nginx
server {
    server_name web3-api.flo-portfolio.com;   # placeholder — pick your own

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

The app sets `trustProxy`, so rate limiting keys off the real client IP rather
than the proxy's. Terminate TLS with Certbot or Caddy's automatic HTTPS.

Set `CORS_ALLOWED_ORIGINS` to the exact production frontend origin. No wildcard.

```
CORS_ALLOWED_ORIGINS=https://flo-portfolio.com,https://www.flo-portfolio.com
```

## 5. Secrets

All backend secrets live in `/srv/flo-portfolio/backend/.env`, owned by the
service user, mode `600`, and gitignored. Nothing else is needed:

```
DATABASE_URL=postgresql://web3:STRONG_PASSWORD@127.0.0.1:5432/web3_index_prod
SEPOLIA_RPC_URL=https://…
```

**No mnemonic and no private key are required by the backend.** It never signs.

Do not set `DATABASE_URL_TEST` here. It exists only on developer machines.

## 6. Vercel

Set exactly one variable:

```
NEXT_PUBLIC_WEB3_API_URL=https://web3-api.flo-portfolio.com
```

Do **not** configure `DATABASE_URL`, `SEPOLIA_RPC_URL`, `DEPLOYER_PRIVATE_KEY`
or `DEMO_MNEMONIC` in Vercel. The frontend needs none of them, and anything
prefixed `NEXT_PUBLIC_` is shipped to every visitor.

The build succeeds without the variable. Next.js injects `NEXT_PUBLIC_*`
configuration into the browser bundle at build time, so a build without this
variable shows "Web3 API not configured". After setting or changing the value,
rebuild and redeploy the frontend.

## 7. Monitoring

Poll `GET /health`. It is exempt from rate limiting so a monitor cannot lock
itself out.

```json
{
  "status": "ok",
  "database": "up",
  "latestIndexedBlock": 11586719,
  "latestChainBlock": 11586725,
  "indexerLagBlocks": 6,
  "lastSuccessfulSync": "2026-08-28T18:02:11.402Z",
  "stale": false
}
```

Alert on `status != "ok"`, `database != "up"`, `stale == true`, or
`indexerLagBlocks` above roughly 50.

## 8. Backups

The database is a **rebuildable projection**, not a system of record — the chain
is. A total loss costs one `indexer:rebuild` from the deployment block, which is
a few minutes for this deployment. So backups are convenience, not durability:

```bash
pg_dump -U web3 web3_index_prod | gzip > /var/backups/web3_$(date +%F).sql.gz
```

Verify a restore occasionally; an untested backup is a guess.

---

## Reorg handling — what it actually does

The checkpoint stores the block hash of the last indexed block. Before the
cursor advances, that hash is re-read from the RPC. On mismatch the indexer
deletes every event in the last `WEB3_INDEXER_REORG_DEPTH` blocks (default 24),
rewinds the cursor, and replays.

**This is a conservative fixed-window strategy, not ancestry walking.** It
handles the shallow reorgs a Sepolia demo realistically encounters. A reorg
deeper than the window would leave stale rows behind; the remedy is:

```bash
npm run indexer:rebuild -- --confirm
```

`rebuild` refuses to run without `--confirm`, and additionally refuses under
`NODE_ENV=production` without `--i-know-this-is-production`, because the API
serves an empty index until it finishes.

Running at `WEB3_INDEXER_CONFIRMATIONS=6` makes a reorg unlikely to be observed
at all: blocks are only indexed once six deep.

---

## Deployment order

1. Provision the VPS, create the `web3` user, install Node 20+ and PostgreSQL.
2. Bind PostgreSQL to localhost. Verify externally that 5432 is closed.
3. Clone the repo, `cd backend && npm ci`.
4. Write `.env` (mode 600). Run `npx prisma migrate deploy`.
5. `npm run indexer:sync` once and check `npm run indexer:status`.
6. Install and start the indexer service; confirm it survives a reboot.
7. Start the API under its own supervisor unit; confirm `/health` locally.
8. Configure Nginx/Caddy, obtain a certificate, confirm `/health` over HTTPS.
9. Set `CORS_ALLOWED_ORIGINS` to the production frontend origin; restart.
10. Set `NEXT_PUBLIC_WEB3_API_URL` in Vercel and redeploy the frontend.
11. Verify the live dashboard, then point monitoring at `/health`.
