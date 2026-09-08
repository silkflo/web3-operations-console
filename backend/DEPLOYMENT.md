# Production deployment — VPS

**Nothing in this document has been executed.** No VPS, DNS, Nginx, Caddy, PM2,
Docker host or production secret was configured during this
milestone. These are the steps for when you choose to deploy.

---

## Architecture

```
                    ┌────────────────────────────────────────────────┐
   Sepolia RPC ───► │  VPS                                           │
                    │                                                │
                    │   indexer ──► PostgreSQL ◄── Fastify API        │
                    │   (long-running)  (localhost only)      ▲       │
                    │                                         │       │
                    │   Next.js frontend                      │       │
                    │            │                            │       │
                    │            └──────────┬─────────────────┘       │
                    │                       │                         │
                    │                 ┌─────▼─────┐                   │
                    │                 │  Nginx    │                   │
                    │                 └─────┬─────┘                   │
                    └───────────────────────┼─────────────────────────┘
                                            │ HTTPS
                                     visitor browser
```

Both the frontend and the API are served from the same VPS behind the same
Nginx. The browser still reaches the API only over public HTTPS, and still holds
no credential of any kind.

## Security boundary

| Layer      | May reach                              | Must never hold                                   |
| ---------- | -------------------------------------- | ------------------------------------------------- |
| Browser    | The public HTTPS API only              | Database URL, RPC secret, any key                 |
| Frontend build | `NEXT_PUBLIC_*` only               | `DATABASE_URL`, RPC secret, mnemonic, private key |
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
WorkingDirectory=/home/floadmin/apps/web3-operations-console-public/backend
EnvironmentFile=/home/floadmin/apps/web3-operations-console-public/backend/.env
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

All backend secrets live in `/home/floadmin/apps/web3-operations-console-public/backend/.env`, owned by the
service user, mode `600`, and gitignored. Nothing else is needed:

```
DATABASE_URL=postgresql://web3:STRONG_PASSWORD@127.0.0.1:5432/web3_index_prod
SEPOLIA_RPC_URL=https://…
```

**No mnemonic and no private key are required by the backend.** It never signs.

Do not set `DATABASE_URL_TEST` here. It exists only on developer machines.

## 6. Frontend

The frontend is served from the **same VPS** as the API, behind the same
Nginx. It is a Next.js Pages Router app; how it is currently served — `next
start` under a process manager, a static export, or an Nginx alias — is a
property of the existing deployment, so **inspect that configuration before
changing anything**:

```bash
pm2 list                                  # what is actually running
sudo nginx -T | grep -A 20 'server_name'  # what Nginx serves, and from where
```

This document deliberately does not name a frontend process: guessing one and
restarting it is how an unrelated service gets taken down.

The frontend build reads exactly two variables:

```
NEXT_PUBLIC_WEB3_API_URL=https://web3-api.flo-portfolio.com
NEXT_PUBLIC_WEB3_REFRESH_MS=90000
```

Do **not** configure `DATABASE_URL`, `SEPOLIA_RPC_URL`, `DEPLOYER_PRIVATE_KEY`
or `DEMO_MNEMONIC` for the frontend build. It needs none of them, and anything
prefixed `NEXT_PUBLIC_` is compiled into the bundle every visitor downloads.

The build succeeds without them. Next.js injects `NEXT_PUBLIC_*` configuration
into the browser bundle at **build** time, so a build without the API URL shows
"Web3 API not configured", and changing either value requires a rebuild — not
just a restart.

## 7. Monitoring

Poll `GET /health`. It is exempt from rate limiting so a monitor cannot lock
itself out, and every read it performs is bounded by `API_HEALTH_TIMEOUT_MS`, so
it answers quickly whether or not the RPC does.

```json
{
  "status": "ok",
  "database": "up",
  "rpc": "up",
  "latestIndexedBlock": 11586719,
  "latestChainBlock": 11586725,
  "chainBlockAgeSeconds": 4,
  "indexerLagBlocks": 6,
  "lastSuccessfulSync": "2026-08-28T18:02:11.402Z",
  "secondsSinceSync": 41.2,
  "stale": false,
  "servingCachedData": true,
  "servingStaleData": false,
  "snapshotState": "cached",
  "snapshotAgeSeconds": 22,
  "uptimeSeconds": 90210
}
```

| Field | Meaning |
|---|---|
| `status` | `ok`, `degraded` or `error`. `degraded` means it is answering, but with something wrong behind it. |
| `database` | `up` or `down`. `down` is the only condition that returns HTTP 503. |
| `rpc` | `up` (a live read succeeded recently), `degraded` (serving a cached block height because the provider is failing), `down` (nothing usable), `not-configured`. |
| `latestIndexedBlock` | The indexer's cursor. |
| `latestChainBlock` | Chain head, from a cache at most `API_CHAIN_HEAD_TTL_SECONDS` old; `chainBlockAgeSeconds` says how old. |
| `indexerLagBlocks` | Chain head minus cursor. |
| `lastSuccessfulSync` / `secondsSinceSync` | When the indexer last completed a pass. |
| `stale` | The index has not synced within `API_STALE_AFTER_SECONDS`. |
| `servingCachedData` | Dashboard responses are coming from the snapshot cache. Normal. |
| `servingStaleData` | A refresh **failed** and visitors are seeing the last good snapshot. Not normal. |

### `/health` alone is not enough

`/health` proves the API is up, the database is reachable and the index is
current. Its `rpc` field is derived from a cached `eth_blockNumber`, and **a
successful `eth_blockNumber` does not prove that contract reads work.** A
provider can serve block heights while rejecting `eth_call`, or a per-method
rate limit can bite only the seven reads each split needs. In that state
`/health` reports `rpc: "up"` while every figure on the dashboard is
reconstructed from indexed events.

So an external monitor needs **two** checks:

| Endpoint | Answers |
|---|---|
| `GET /health` | Is the API up? Is the database reachable? Is the index current? |
| `GET /api/v1/web3/dashboard` | Are the figures visitors actually see live? |

The second is the only one that can tell you the dashboard has quietly degraded.

### What to alert on

No paid dependency is required — an HTTP check that can assert on a JSON field
is enough (Uptime Kuma, Better Stack, healthchecks.io, or a cron running `curl`
plus `jq`).

| Alert | Check | Condition | Why it matters |
|---|---|---|---|
| API down | `/health` | HTTP status is not 200, or the request times out | The public demo is unreachable. |
| Database down | `/health` | `database != "up"` (returns 503) | Nothing can be served; the index is unreachable. |
| Index lag | `/health` | `indexerLagBlocks > 300`, or `stale == true` | The indexer is behind, stopped or crash-looping. `indexerLagBlocks` is **null**, not zero, when no chain head is available — treat null as "unknown", not "fine". |
| Chain head unreadable | `/health` | `rpc != "up"` for more than ~10 minutes | The provider is not answering at all. |
| Dashboard degraded | `/api/v1/web3/dashboard` | `freshness.source != "live"`, or `freshness.degraded == true`, for more than ~10 minutes | Current-state figures are no longer live contract reads. This is the check `/health` cannot make for you. |
| Serving stale data | `/api/v1/web3/dashboard` | `freshness.stale == true` | A refresh failed; visitors are seeing the last good snapshot. |

```bash
BASE=https://web3-api.flo-portfolio.com

# 1. API and database
curl -fsS --max-time 10 "$BASE/health" | jq -e '.database == "up"'

# 2. The data visitors actually see
curl -fsS --max-time 15 "$BASE/api/v1/web3/dashboard" \
  | jq -e '.freshness.source == "live" and .freshness.degraded == false'
```

`freshness.currentState` breaks the second check down per split
(`{live, lastKnownGood, derived, total}`) when you want to know how much of the
dashboard is affected rather than merely that something is.

Thresholds are deliberately loose. `freshness.source` flipping away from `live`
for one poll is a rate limit being absorbed exactly as designed, not an
incident; alert on it persisting. The dashboard endpoint is rate limited (unlike
`/health`), so poll it no more often than once a minute.

## 8. Backups

The database is a **rebuildable projection**, not a system of record — the chain
is. A total loss costs one `indexer:rebuild` from the deployment block, which is
a few minutes for this deployment. So backups are convenience, not durability:

```bash
pg_dump -U web3 web3_index_prod | gzip > /var/backups/web3_$(date +%F).sql.gz
```

Verify a restore occasionally; an untested backup is a guess.

---

## Behaviour under RPC failure

The demo is a single VPS in front of a metered public RPC. It is designed to
degrade rather than disappear.

```
RPC healthy      fresh live reads, cached for API_SNAPSHOT_TTL_SECONDS
RPC slow         each call is cut at RPC_TIMEOUT_MS; the snapshot still builds
RPC rate-limited one attempt, then a cooldown; current state falls back to the
                 index and the page says so
RPC gone         the last good snapshot is served for up to
                 API_SNAPSHOT_MAX_STALE_SECONDS, labelled stale; after that the
                 page shows indexed history with current state unavailable
Database gone    /health returns 503; nothing else can be served
```

Three properties hold in every case:

1. **Bounded latency.** Every RPC-dependent operation has a hard timeout, and the
   API answers well inside Nginx's 30s. Ethers' own defaults — a 300 second
   request timeout and twelve retries on a 429 — are overridden in
   `src/chain/provider.js`.
2. **One refresh, shared.** Concurrent callers join a single in-flight snapshot
   refresh. `/splits`, `/summary` and `/dashboard` arriving together cost one set
   of chain reads.
3. **Nothing is claimed that is not true.** Every snapshot response carries a
   `freshness` block (`fresh` / `cached` / `degraded` / `stale`), and cached or
   indexed values are never presented as current live-chain values.

### What the load actually was

| | Before | After |
|---|---|---|
| HTTP requests per refresh | 3 (`/health`, `/splits`, `/summary`, concurrently) | 1 (`/api/v1/web3/dashboard`) |
| JSON-RPC operations per refresh | ~45 (each endpoint rebuilt its own snapshot) | ~22, and only when the cache has expired |
| Refresh interval | 15s | 90s, paused while the tab is hidden |
| Per continuously open, **visible** tab | ~12 HTTP requests and ~180 JSON-RPC operations a minute | ~0.7 HTTP requests a minute; RPC cost is shared, not per tab |

The per-minute figures assume a tab left open and visible. A hidden tab now
costs nothing at all, and additional tabs no longer multiply the RPC load,
because they share one cached snapshot on the server.

### Configuration added for this

| Variable | Default | Recommended here | Purpose |
|---|---|---|---|
| `RPC_TIMEOUT_MS` | `8000` | `8000` | Hard bound on one API-path RPC call. |
| `RPC_MAX_ATTEMPTS` | `1` | `1` | HTTP attempts per call. `1` disables ethers' retry storm. |
| `API_SNAPSHOT_TTL_SECONDS` | `60` | `60` | How long a snapshot serves as current. |
| `API_SNAPSHOT_MAX_STALE_SECONDS` | `900` | `900` | Oldest snapshot still served, labelled stale. |
| `API_CHAIN_HEAD_TTL_SECONDS` | `15` | `15` | Chain-head cache, shared with `/health`. |
| `API_RPC_ERROR_COOLDOWN_SECONDS` | `30` | `30` | Quiet period after an RPC failure. |
| `API_HEALTH_TIMEOUT_MS` | `2000` | `2000` | Bound on every read `/health` performs. |
| `WEB3_INDEXER_POLL_MS` | `60000` | `60000` | Delay after a pass that reached the head. |
| `WEB3_INDEXER_CATCHUP_POLL_MS` | `2000` | `5000` | Delay after a pass that is still behind. |
| `WEB3_INDEXER_CHUNK_SIZE` | `2000` | `500` | Largest `eth_getLogs` range attempted. |
| `WEB3_INDEXER_MIN_CHUNK_SIZE` | `25` | `25` | Floor when a provider refuses the range. |
| `WEB3_INDEXER_CHUNK_DELAY_MS` | `250` | `500` | Pause between chunks. |
| `WEB3_INDEXER_MAX_BLOCKS_PER_PASS` | `5000` | `2000` | Blocks per pass; `0` disables. |
| `WEB3_INDEXER_RPC_TIMEOUT_MS` | `20000` | `20000` | Per-call bound for the indexer. |
| `WEB3_INDEXER_MAX_ATTEMPTS` | `4` | `4` | Attempts per chunk before the pass gives up. |
| `WEB3_INDEXER_BACKOFF_MS` | `2000` | `5000` | First backoff delay; doubles per attempt. |
| `WEB3_INDEXER_BACKOFF_MAX_MS` | `300000` | `300000` | Cap on that backoff. |
| `NEXT_PUBLIC_WEB3_REFRESH_MS` | `90000` | `90000` | Frontend refresh interval (frontend build environment). |

The "recommended here" column is tuned for a **shared public RPC**
(`ethereum-sepolia-rpc.publicnode.com`) with a backlog to clear: smaller ranges,
longer pauses, slower catch-up. On a healthy authenticated endpoint the defaults
are fine and catch-up is faster.

Every value is validated at startup. An out-of-range value fails fast with the
name of the variable rather than being silently coerced.

### Why the chunk size matters

`eth_getLogs` limits differ per provider and none of them advertise theirs. The
indexer treats `WEB3_INDEXER_CHUNK_SIZE` as an upper bound to attempt: if a
provider refuses the range it halves the chunk and retries immediately — no
backoff, because nothing is overloaded — down to `WEB3_INDEXER_MIN_CHUNK_SIZE`,
then grows back after three clean chunks.

A rate-limit message is checked **before** a range message, because "Monthly
capacity limit exceeded" also contains the words "limit exceeded" and must be
backed off from, not answered with a smaller range.

Do not set `WEB3_INDEXER_CHUNK_SIZE` to a very small value "to be safe". At 10
blocks a chunk, a 12,500-block backlog is ~1,250 chunks and roughly 17,500
`eth_getLogs` calls — which is what exhausted the quota in the first place.

---

## Deploying this change set

Nothing below has been executed. Run it yourself, in this order.

Both the API and the frontend run on the **same VPS**, from
`/home/floadmin/apps/web3-operations-console-public`. Adjust the path if your
checkout differs; the commands assume it.

### 0. Before you start

```bash
cd /home/floadmin/apps/web3-operations-console-public
git log --oneline -1          # note the current commit for rollback
git status --short            # the tree should be clean before you pull
pm2 list                      # note EVERY process and its state
pm2 save --force              # snapshot the CURRENT process list first
curl -fsS --max-time 10 http://127.0.0.1:4000/health | jq .
```

Write down the process names `pm2 list` prints. This document names
`web3-api` and `web3-indexer` because the incident report does; if yours differ,
substitute them, and do not assume a frontend process exists until you have seen
it (see step 6).

The indexer is expected to be stopped and behind. Leave it stopped for now.

### 1. Pull and install

```bash
cd /home/floadmin/apps/web3-operations-console-public
git pull --ff-only
npm --prefix backend ci
```

No new runtime dependency is introduced, so `ci` is a reinstall, not an upgrade.
Leave the frontend install until step 6, so a broken frontend build cannot
delay the API fix.

### 2. Add the new environment variables

Edit `/home/floadmin/apps/web3-operations-console-public/backend/.env` (mode 600, owned by the service user).
**Append only** — do not rewrite the existing values, and do not copy anything
out of this file.

```bash
cat >> /home/floadmin/apps/web3-operations-console-public/backend/.env <<'ENV'

# --- resilience (added with the RPC hardening change) ---
RPC_TIMEOUT_MS=8000
RPC_MAX_ATTEMPTS=1

API_SNAPSHOT_TTL_SECONDS=60
API_SNAPSHOT_MAX_STALE_SECONDS=900
API_CHAIN_HEAD_TTL_SECONDS=15
API_RPC_ERROR_COOLDOWN_SECONDS=30
API_HEALTH_TIMEOUT_MS=2000

WEB3_INDEXER_POLL_MS=60000
WEB3_INDEXER_CATCHUP_POLL_MS=5000
WEB3_INDEXER_CHUNK_DELAY_MS=500
WEB3_INDEXER_MAX_BLOCKS_PER_PASS=2000
WEB3_INDEXER_RPC_TIMEOUT_MS=20000
WEB3_INDEXER_MAX_ATTEMPTS=4
WEB3_INDEXER_BACKOFF_MS=5000
WEB3_INDEXER_BACKOFF_MAX_MS=300000
ENV
```

Then check the pre-existing `WEB3_INDEXER_CHUNK_SIZE`. If it is `10`, raise it:

```bash
grep -c '^WEB3_INDEXER_CHUNK_SIZE=' /home/floadmin/apps/web3-operations-console-public/backend/.env
sed -i 's/^WEB3_INDEXER_CHUNK_SIZE=.*/WEB3_INDEXER_CHUNK_SIZE=500/' /home/floadmin/apps/web3-operations-console-public/backend/.env
sed -i 's/^WEB3_INDEXER_POLL_MS=.*/WEB3_INDEXER_POLL_MS=60000/' /home/floadmin/apps/web3-operations-console-public/backend/.env
grep -E '^WEB3_INDEXER_(CHUNK_SIZE|POLL_MS)=' /home/floadmin/apps/web3-operations-console-public/backend/.env
```

If `MIN_CHUNK_SIZE` ends up larger than `CHUNK_SIZE` it is clamped down rather
than rejected, so the API cannot fail to start over it.

No migration is required: this change adds no table and no column.

### 3. Restart the API only

The indexer stays stopped until the API is confirmed healthy.

```bash
pm2 restart web3-api --update-env
pm2 logs web3-api --lines 40 --nostream
```

`--update-env` matters: without it PM2 reuses the old environment and none of
the new variables take effect.

### 4. Health checks

```bash
# Local, and fast even if the RPC is unhappy
time curl -fsS --max-time 10 http://127.0.0.1:4000/health | jq .

# Expect: database "up", a "rpc" field, and a "snapshotState" field
curl -fsS http://127.0.0.1:4000/health | jq '{status,database,rpc,servingStaleData,indexerLagBlocks}'
```

`/health` should answer in well under a second.

### 5. Public API checks, with the real CORS origin

```bash
BASE=https://web3-api.flo-portfolio.com
ORIGIN=https://web3.flo-portfolio.com

curl -fsS --max-time 15 "$BASE/health" | jq '{status,database,rpc}'

# The combined dashboard route, and the CORS header for the real frontend
curl -fsS --max-time 15 -H "Origin: $ORIGIN" -D- -o /dev/null "$BASE/api/v1/web3/dashboard" \
  | grep -i access-control-allow-origin

# One refresh, then a second: the second must be served from cache
curl -fsS -H "Origin: $ORIGIN" "$BASE/api/v1/web3/dashboard" | jq '.freshness'
curl -fsS -H "Origin: $ORIGIN" "$BASE/api/v1/web3/dashboard" | jq '.freshness'
```

Expect `state: "fresh"` then `state: "cached"` with `servedFromCache: true`.
An unknown origin must get no `access-control-allow-origin` header at all:

```bash
curl -fsS -H "Origin: https://attacker.example" -D- -o /dev/null "$BASE/health" \
  | grep -i access-control-allow-origin || echo "correctly refused"
```

Confirm the legacy routes still answer, since monitors and older frontend builds
use them:

```bash
for path in /health /api/v1/web3/splits /api/v1/web3/summary; do
  printf '%s -> ' "$path"
  curl -fsS -o /dev/null -w '%{http_code}\n' --max-time 15 "$BASE$path"
done
```

### 6. Frontend

The frontend is on this VPS, not on a hosting platform. Before touching it,
find out how it is currently served — this document does not guess:

```bash
pm2 list
sudo nginx -T | grep -B 5 -A 25 'web3\.'   # or whichever server_name applies
```

That tells you whether Nginx proxies to a running Next.js server (in which case
that process must be restarted after a rebuild) or serves built files from disk
(in which case it must not).

`NEXT_PUBLIC_*` values are compiled into the bundle at **build** time, so both
of these must be present in the build environment — in the shell that runs the
build, or in a `.env.production` / `.env.local` the build reads:

```
NEXT_PUBLIC_WEB3_API_URL=https://web3-api.flo-portfolio.com
NEXT_PUBLIC_WEB3_REFRESH_MS=90000
```

Then build:

```bash
cd /home/floadmin/apps/web3-operations-console-public
npm ci
npm run build
```

Restart or reload the frontend **using the process name you actually saw**, not
one from this document.

Deploy the backend first. A frontend built against a backend that has no
`/api/v1/web3/dashboard` falls back to the three legacy calls: it still works,
but it gives up the request reduction, which is the point of the change.

### 7. Browser verification

Open <https://web3.flo-portfolio.com> with DevTools on the Network tab:

- **One** request per refresh, to `/api/v1/web3/dashboard`.
- The next one about 90 seconds later, not 15.
- Switch to another tab for two minutes: **no** requests while hidden.
- Switch back: one request, then the normal interval resumes.
- Click **Retry** twice quickly: one request, not two.
- The freshness banner reads correctly — "Index current" when the indexer is
  caught up, an explicit stale or degraded message otherwise.

### 8. Controlled indexer catch-up

Only after the API is confirmed healthy, and never against the shared public RPC
at full speed. The indexer is roughly 12,500 blocks behind.

**First, one manual pass in the foreground**, watching what it does:

```bash
cd /home/floadmin/apps/web3-operations-console-public/backend
npm run indexer:status
WEB3_INDEXER_MAX_BLOCKS_PER_PASS=500 npm run indexer:sync
```

That indexes at most 500 blocks and exits. Check that the API stayed responsive
while it ran, and that the cursor moved:

```bash
curl -fsS --max-time 10 http://127.0.0.1:4000/health | jq '{indexerLagBlocks,latestIndexedBlock}'
npm run indexer:status
```

Repeat that command a few times. If each pass is clean and `/health` stays fast,
start the managed process:

```bash
pm2 start web3-indexer --update-env
pm2 logs web3-indexer --lines 40 --nostream
```

Then watch the lag close, checking that the API stays healthy throughout:

```bash
watch -n 30 'curl -fsS --max-time 10 http://127.0.0.1:4000/health | jq "{status,rpc,indexerLagBlocks,servingStaleData}"'
```

At 2,000 blocks per pass and a 5s catch-up delay, 12,500 blocks is roughly
seven passes. If `rpc` goes to `degraded` and stays there, stop the indexer
(`pm2 stop web3-indexer`) and let the provider recover — the API keeps serving
indexed data, and the page keeps telling visitors it is stale.

To go slower still, lower the budget for the catch-up and raise it afterwards:

```bash
sed -i 's/^WEB3_INDEXER_MAX_BLOCKS_PER_PASS=.*/WEB3_INDEXER_MAX_BLOCKS_PER_PASS=500/' .env
pm2 restart web3-indexer --update-env
```

### 9. Persist the process list

**Only after** the API and the indexer have both been healthy for a while —
say 15 minutes with `indexerLagBlocks` falling and `status` not `error`:

```bash
pm2 save
```

`pm2 save` writes the current process list to the resurrect file used on boot.
Running it while something is stopped or crash-looping persists exactly that, so
do not run it during step 8, and do not run it if you are still deciding whether
to roll back.

### 10. Rollback

The change is code and configuration only — no migration, no data change — so a
rollback is a checkout and a restart.

```bash
cd /home/floadmin/apps/web3-operations-console-public
pm2 stop web3-indexer            # stop the noisier process first
git checkout <previous-commit>   # the hash noted in step 0
npm --prefix backend ci
pm2 restart web3-api --update-env
curl -fsS --max-time 10 http://127.0.0.1:4000/health | jq .
```

The new variables can stay in `.env`; the previous code ignores them. If you
edited `WEB3_INDEXER_CHUNK_SIZE`, put the old value back — the previous code has
no adaptive sizing and will attempt whatever you leave there.

Then rebuild the frontend from the same previous commit and restart or reload
whatever serves it, and only once you are settled:

```bash
pm2 start web3-indexer --update-env
pm2 save
```

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
10. Set `NEXT_PUBLIC_WEB3_API_URL` and `NEXT_PUBLIC_WEB3_REFRESH_MS` in the
    frontend build environment on the VPS, rebuild, and reload whatever serves
    it.
11. Verify the live dashboard, then point monitoring at `/health`.
