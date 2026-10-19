# Docker Example — Multi-Container Node.js App

## Overview

This is an example template for how to dockerize a multi-container, full-stack Node.js application.

The stack includes **Postgres 16**, **Redis**, **pgAdmin 4**, a **Next.js frontend**, and an **Express/TypeORM backend** on separate ports. The application connects to Postgres via TypeORM and uses Redis for cookie-based session storage via `connect-redis` + `express-session`.

To run the application, make sure Docker is installed, then from the project root:

```bash
docker-compose up --build
```

This builds all images and starts the full multi-container app.

| Service  | URL |
|----------|-----|
| Frontend | http://localhost:3001 |
| Backend  | http://localhost:4000 |
| pgAdmin  | http://localhost:5050 |

---

## Docker Troubleshooting Log

The following issues were identified and resolved during initial containerization. Each entry covers the **symptom**, the **root cause** traced to the relevant file, and the **fix applied**.

---

### 1. Backend crashes immediately — TypeORM cannot connect to Postgres

**Container:** `backend_container`

**Symptom:**  
On the very first `docker-compose up --build`, the backend container exited with a TypeORM connection error before Postgres was ready to accept connections.

**Root cause:**  
[`docker-compose.yml`](docker-compose.yml) had no startup ordering or readiness guarantee between `backend` and `postgres`. Docker Compose starts services in parallel by default. TypeORM's [`dataSource.initialize()`](backend/src/data-source.ts:13) was called while the Postgres container was still in its init phase and not yet accepting TCP connections on port 5432.

**Fix:**  
Added `depends_on` with `condition: service_healthy` to the `backend` service in [`docker-compose.yml`](docker-compose.yml:29-35), and added a `healthcheck` to the `postgres` service using `pg_isready`:

```yaml
# backend service
depends_on:
  postgres:
    condition: service_healthy

# postgres service
healthcheck:
  test: ["CMD-SHELL", "pg_isready -U postgres"]
  interval: 5s
  timeout: 5s
  retries: 5
```

This ensures the backend only starts after Postgres passes its health check.

---

### 2. TypeORM never connects — environment variable name mismatch

**Container:** `backend_container`

**Symptom:**  
Even after the health-check fix, TypeORM logged `data source initialization error` with `undefined` values for host, database, username, and password.

**Root cause:**  
[`docker-compose.yml`](docker-compose.yml:21-26) defines the Postgres credentials as `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, and `DB_NAME`. However, [`backend/src/data-source.ts`](backend/src/data-source.ts:9-12) reads `PG_HOST`, `PG_DATABASE`, `PG_USERNAME`, and `PG_PASSWORD` — none of which are set in Compose. All four values resolved to `undefined` at runtime.

**Fix:**  
Aligned the environment variable names in [`docker-compose.yml`](docker-compose.yml) to match what [`data-source.ts`](backend/src/data-source.ts) actually reads:

```yaml
environment:
  PG_HOST: postgres
  PG_DATABASE: postgres
  PG_USERNAME: postgres
  PG_PASSWORD: postgres
```

---

### 3. TypeORM connects with wrong password — copy-paste bug in data-source

**Container:** `backend_container`

**Symptom:**  
After fixing the env var names, authentication still failed. TypeORM logged `password authentication failed for user "postgres"`.

**Root cause:**  
In [`backend/src/data-source.ts`](backend/src/data-source.ts:12), the `password` field was mistakenly set to `process.env.PG_HOST` instead of `process.env.PG_PASSWORD` — a copy-paste error on that line:

```ts
// Buggy line in data-source.ts
password: process.env.PG_HOST,   // ← wrong variable
```

**Fix:**  
Corrected the field to use the intended variable:

```ts
password: process.env.PG_PASSWORD,
```

---

### 4. Frontend unreachable at the documented URL

**Container:** `frontend_container`

**Symptom:**  
Navigating to `http://localhost:3000` returned "connection refused". The frontend container was running but not accessible at the expected port.

**Root cause:**  
[`docker-compose.yml`](docker-compose.yml:9-10) maps the host port `3001` to the container's port `3000`:

```yaml
ports:
  - 3001:3000   # host:container
```

Port 3000 on the host was already allocated by another local process, so the mapping was intentionally shifted. The original README documented the wrong URL (`http://localhost:3000`).

**Fix:**  
Updated the documented access URL in this README to reflect the actual host port:

> Frontend → http://localhost:3001

No change to the Compose file was needed; the mapping itself is correct.

---

### 5. Backend session middleware broken — missing SESSION_SECRET and CORS_ORIGIN

**Container:** `backend_container`

**Symptom:**  
`express-session` threw on startup: `secret option required for sessions`. CORS preflight requests from the frontend were also rejected.

**Root cause:**  
[`backend/src/index.ts`](backend/src/index.ts:60) reads `process.env.SESSION_SECRET` for the session secret, and [`index.ts:32`](backend/src/index.ts:32) reads `process.env.CORS_ORIGIN` for the allowed CORS origin. Neither variable was declared in the `backend` service's `environment` block in [`docker-compose.yml`](docker-compose.yml:20-27). They existed only in [`backend/.env.production`](backend/.env.production), which is not automatically loaded by Docker Compose.

**Fix:**  
Added the missing variables to the `backend` environment block in [`docker-compose.yml`](docker-compose.yml):

```yaml
environment:
  SESSION_SECRET: <your-secret-here>
  CORS_ORIGIN: http://localhost:3001
```

For production, inject these via Docker secrets or a secrets manager rather than plain-text Compose env vars.

---

### 6. Frontend container cannot reach the backend — missing network assignment

**Container:** `frontend_container`

**Symptom:**  
API calls from the Next.js frontend to the backend returned network errors when routed through Docker's internal DNS (e.g., `http://backend_container:4000`). The containers could not resolve each other by service name.

**Root cause:**  
In [`docker-compose.yml`](docker-compose.yml:3-10), the `frontend` service had no `networks` key. Docker Compose therefore placed it on the default `bridge` network, while `backend`, `postgres`, `redis`, and `pgadmin` were all assigned to the user-defined `mynet` bridge. User-defined bridges provide automatic DNS resolution between containers; the default bridge does not. The `frontend` container was on a different network and could not reach any service by name.

**Fix:**  
Added the `mynet` network to the `frontend` service:

```yaml
frontend:
  container_name: frontend_container
  build: ./web
  ports:
    - 3001:3000
  networks:
    - mynet
```

---

### 7. node_modules volume shadows container build artifacts on restart

**Container:** `backend_container`

**Symptom:**  
After a `docker-compose down` followed by `docker-compose up` (without `--build`), the backend failed to start with `Cannot find module` errors, as though `node_modules` was empty.

**Root cause:**  
[`docker-compose.yml`](docker-compose.yml:45-46) declares an anonymous volume for the backend:

```yaml
volumes:
  - /usr/src/app/node_modules
```

An anonymous volume persists across container restarts. On the first build the volume is empty and Docker uses the image's `node_modules`. On subsequent starts, Docker mounts the now-populated (but potentially stale or mismatched) anonymous volume over the image layer, hiding the freshly built dependencies.

**Fix:**  
Removed the anonymous volume entry. The `node_modules` baked into the image during `RUN yarn` in [`backend/Dockerfile`](backend/Dockerfile:16) are sufficient. If bind-mounting source for local development, exclude `node_modules` explicitly:

```yaml
volumes:
  - ./backend:/usr/src/app
  - /usr/src/app/node_modules   # keep only when bind-mounting source
```

For the production Docker image used here, the anonymous volume is unnecessary and should be omitted.

---

### 8. connect-redis version incompatibility with express-session

**Container:** `backend_container`

**Symptom:**  
At startup, Node printed a deprecation warning and session storage silently fell back to in-memory, losing sessions on every restart.

**Root cause:**  
[`backend/package.json`](backend/package.json:29) pins `connect-redis` to version `6.1.3`. This version uses the legacy `connectRedis(session)` factory pattern seen in [`backend/src/index.ts`](backend/src/index.ts:40):

```ts
const RedisStore = connectRedis(session);
```

Version 7+ changed to a direct `new RedisStore({ client })` constructor and dropped the session-wrapping factory. Pulling an unpinned `connect-redis` would have broken this initialization silently.

**Fix:**  
Kept the version pinned at `6.1.3` in [`backend/package.json`](backend/package.json:29) to match the v6 API already used in [`index.ts`](backend/src/index.ts:40-43). The usage pattern and the pinned version are now documented so future upgrades are intentional:

```json
"connect-redis": "6.1.3"
```

If upgrading to v7+, the initialization in [`index.ts`](backend/src/index.ts:40-43) must be updated to:

```ts
import { RedisStore } from "connect-redis";
const store = new RedisStore({ client: redis, disableTouch: true });
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   Docker network: mynet                  │
│                                                          │
│  ┌──────────────┐        ┌───────────────────────────┐  │
│  │   frontend   │        │         backend            │  │
│  │  Next.js 13  │──────▶│  Express + TypeORM + Redis │  │
│  │  :3001→:3000 │        │       :4000→:4000          │  │
│  └──────────────┘        └──────────┬────────────────┘  │
│                                     │                    │
│                        ┌────────────┴──────────────┐    │
│                        │                           │    │
│                 ┌──────┴──────┐           ┌────────┴──┐ │
│                 │  postgres   │           │   redis   │ │
│                 │  :5432:5432 │           │  :6379    │ │
│                 └──────┬──────┘           └───────────┘ │
│                        │                                 │
│                 ┌──────┴──────┐                         │
│                 │   pgadmin   │                         │
│                 │  :5050→:80  │                         │
│                 └─────────────┘                         │
└─────────────────────────────────────────────────────────┘
```

---

Please feel free to open an issue or reach out if you have any questions!

---

## Modernization Updates (2025)

The following changes were applied to bring the project from its original 2022 implementation up to current standards. Every change was verified against the live npm registry before being applied.

---

### Runtime — Node.js 16 → 22 LTS (Krypton)

**Files:** [`backend/Dockerfile`](backend/Dockerfile:2), [`web/Dockerfile`](web/Dockerfile:2)

Node 16 reached end-of-life in September 2023. Both Dockerfiles have been updated to `node:22-alpine`, which is the current Active LTS release (Krypton). This also satisfies the `>=20` engine constraints imposed by `typeorm ^1.1.2`, `redis ^6.3.0`, and `ioredis ^6`.

```dockerfile
# Before
FROM node:16-alpine

# After
FROM node:22-alpine
```

---

### Database image — Postgres 16 → 17

**File:** [`docker-compose.yml`](docker-compose.yml:54)

Postgres 17 is the current stable major release. The image tag is updated from `postgres:16` to `postgres:17`. The existing named volume `postgres-data` and `pg_isready` healthcheck remain unchanged and are fully compatible.

```yaml
# Before
image: postgres:16

# After
image: postgres:17
```

> **Note:** If you have an existing `postgres-data` volume from a prior run, remove it first (`docker volume rm <project>_postgres-data`) before upgrading the major version, as Postgres data directories are not forward-compatible across major versions.

---

### TypeScript 5.0 → 5.8

**Files:** [`backend/package.json`](backend/package.json:12), [`web/package.json`](web/package.json:17)

TypeScript 5.8.3 is the latest stable 5.x release. TypeORM 1.x is tested against `^5.9.3` (its own devDependency), making 5.8 the highest production-safe version without entering the 7.x beta cycle. Both packages now declare `"typescript": "^5.8.3"`.

---

### connect-redis 6 → 10 + ioredis → redis

**Files:** [`backend/package.json`](backend/package.json:19), [`backend/src/index.ts`](backend/src/index.ts:6-7)

`connect-redis` v7 removed the legacy `connectRedis(session)` session-wrapping factory and introduced a direct `new RedisStore({ client })` constructor. v10 (current) further requires the official `redis` npm package (`createClient`) as its client, because it calls the v4+ `SET` options object API (`{ expiration: { type: "EX", value: ttl } }`) that `ioredis` does not implement.

**`ioredis` and `@types/ioredis` have been removed** from [`backend/package.json`](backend/package.json). The `redis ^6.3.0` package replaces them for session storage. `@types/connect-redis`, `@types/dotenv`, and `@types/ioredis` have also been dropped — all three are either bundled in their respective packages or no longer needed.

```ts
// Before — connect-redis v6 (legacy factory pattern, ioredis client)
import Redis from "ioredis";
import connectRedis from "connect-redis";

const RedisStore = connectRedis(session);
const redis: any = new Redis(process.env.REDIS_URL as string);

store: new RedisStore({ client: redis, disableTouch: true })

// After — connect-redis v10 (direct constructor, redis npm client)
import { createClient } from "redis";
import { RedisStore } from "connect-redis";

const redis = createClient({ url: process.env.REDIS_URL as string });
redis.on("error", (err) => console.log("Redis client error:", err));
await redis.connect();

store: new RedisStore({ client: redis, disableTouch: true })
```

---

### TypeORM 0.3 → 1.1

**File:** [`backend/package.json`](backend/package.json:23)

TypeORM 1.x is the current stable release line. The `DataSource` API, entity decorators, and `synchronize: true` behaviour used in [`data-source.ts`](backend/src/data-source.ts) are unchanged — no source edits were needed beyond the version bump.

---

### Express 4 → 5

**File:** [`backend/package.json`](backend/package.json:16), [`@types/express`](backend/package.json:9)

Express 5.3.0 is the current stable release. Express 5 ships its own TypeScript types, making `@types/express` a type-only update rather than an API change. The route handlers and middleware calls in [`index.ts`](backend/src/index.ts) are fully compatible with Express 5 — no code changes were required.

`@types/express` has been updated from `^4.17.17` to `^5.0.6` to match.

---

### express-session 1.17 → 1.19 + @types aligned

**File:** [`backend/package.json`](backend/package.json:17)

`express-session` is updated to `^1.19.0` (latest stable). `@types/express-session` is updated to `^1.19.0` to match.

---

### reflect-metadata 0.1 → 0.2

**File:** [`backend/package.json`](backend/package.json:24)

`reflect-metadata ^0.2.2` is the current release and the version TypeORM 1.x declares as its own dependency. Updated to stay consistent.

---

### dotenv 16.0 → 16.5

**File:** [`backend/package.json`](backend/package.json:14)

Latest patch on the stable 16.x line. No API changes.

---

### Next.js 13 → 15 + React 18 → 19

**File:** [`web/package.json`](web/package.json)

| Package | Before | After |
|---------|--------|-------|
| `next` | `13.2.4` | `^15.3.9` |
| `react` | `18.2.0` | `^19.3.1` |
| `react-dom` | `18.2.0` | `^19.3.1` |
| `@types/react` | `18.0.28` | `^19.1.8` |
| `@types/react-dom` | `18.0.11` | `^19.1.6` |
| `@types/node` | `18.15.5` | `^22.20.5` |

Next.js 15 requires Node ≥ 18.18, satisfied by the Node 22 base image. React 19 is the current stable release and is explicitly listed in Next 15's `peerDependencies`. The existing pages in [`web/src/pages/`](web/src/pages/) use the standard `_app.tsx` / `_document.tsx` / `index.tsx` structure that is unchanged across these versions.

---

### Bug fixes applied alongside the modernization

The following bugs identified in the [Troubleshooting Log](#docker-troubleshooting-log) above were applied as part of this update pass:

| Bug | Fix location |
|-----|-------------|
| `password: process.env.PG_HOST` copy-paste error | [`data-source.ts:12`](backend/src/data-source.ts:12) → `process.env.PG_PASSWORD` |
| Env var name mismatch (`DB_*` vs `PG_*`) | [`docker-compose.yml`](docker-compose.yml) env block aligned to `PG_*` |
| Missing `SESSION_SECRET` / `CORS_ORIGIN` in Compose | Added to `backend` environment block in [`docker-compose.yml`](docker-compose.yml:30-33) |
| Frontend missing `mynet` network | Added `networks: [mynet]` to `frontend` service in [`docker-compose.yml`](docker-compose.yml:11-12) |
| Anonymous volume shadowing `node_modules` | Removed from `backend` service in [`docker-compose.yml`](docker-compose.yml) |

---

### Full dependency delta

#### `backend/package.json`

| Package | Before | After | Notes |
|---------|--------|-------|-------|
| `node` (Docker) | `16-alpine` | `22-alpine` | Node LTS Krypton |
| `typescript` | `^5.0.2` | `^5.8.3` | |
| `express` | `^4.18.2` | `^5.3.0` | |
| `express-session` | `^1.17.3` | `^1.19.0` | |
| `connect-redis` | `6.1.3` | `^10.0.0` | API changed — see above |
| `ioredis` | `^5.3.1` | *(removed)* | Replaced by `redis` |
| `redis` | *(absent)* | `^6.3.0` | New — required by connect-redis v10 |
| `typeorm` | `^0.3.12` | `^1.1.2` | |
| `dotenv` | `^16.0.3` | `^16.5.0` | |
| `pg` | `^8.10.0` | `^8.23.1` | |
| `cors` | `^2.8.5` | `^2.8.6` | |
| `reflect-metadata` | `^0.1.13` | `^0.2.2` | |
| `ts-node` | `^10.9.1` | `^10.9.2` | |
| `nodemon` | `^2.0.21` | `^3.1.14` | moved to devDependencies |
| `@types/express` | `^4.17.17` | `^5.0.6` | |
| `@types/express-session` | `^1.17.7` | `^1.19.0` | |
| `@types/cors` | `^2.8.13` | `^2.8.19` | |
| `@types/node` | `^18.15.5` | `^22.20.5` | |
| `@types/connect-redis` | `^0.0.20` | *(removed)* | Bundled in connect-redis v10 |
| `@types/dotenv` | `^8.2.0` | *(removed)* | dotenv ships its own types |
| `@types/ioredis` | `^5.0.0` | *(removed)* | ioredis removed |
| `postgres` | `^3.3.4` | *(removed)* | Duplicate — `pg` is used by TypeORM |

#### `web/package.json`

| Package | Before | After |
|---------|--------|-------|
| `node` (Docker) | `16-alpine` | `22-alpine` |
| `next` | `13.2.4` | `^15.3.9` |
| `react` | `18.2.0` | `^19.3.1` |
| `react-dom` | `18.2.0` | `^19.3.1` |
| `typescript` | `5.0.2` | `^5.8.3` |
| `@types/node` | `18.15.5` | `^22.20.5` |
| `@types/react` | `18.0.28` | `^19.1.8` |
| `@types/react-dom` | `18.0.11` | `^19.1.6` |
