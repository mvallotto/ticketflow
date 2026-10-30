# TicketFlow

TicketFlow is a full-stack event reservation demo focused on inventory correctness: concurrent reservations, idempotent checkout, confirmation, expiration, and recovery from uncertain network outcomes.

The React interface provides an event catalog, ticket selection, booking confirmation, and visitor-specific order lists. The backend reserves inventory for ten minutes and issues ticket records when an order is confirmed. Payment processing and real authentication are outside the current scope.

## Installation and local development

### Requirements

- Node.js and npm with workspace support. Development and checks were performed with **Node.js 26.13.0 and npm 11.20.0**; other versions have not been validated.
- Docker with Docker Compose. The inspected environment uses Compose 5.6.1; Compose must support `up --wait` for the commands below.
- Available local ports: `3000` for the API, `5173` for Vite, `5432` for the development database, and `5433` for the test database.

The examples use Bash from the repository root. On Windows, use WSL2 Ubuntu with Linux Node/npm and Docker integration enabled. Avoid mixing Windows npm with dependencies installed inside WSL.

### 1. Install dependencies and configure the API

For a fresh checkout:

```sh
npm ci
cp .env.example apps/api/.env
```

For an existing checkout, keep your current `apps/api/.env` rather than overwriting it. The supplied development setting is:

```dotenv
DATABASE_URL=postgresql://ticketflow:ticketflow@localhost:5432/ticketflow
```

The API and Drizzle scripts load `.env` from the workspace working directory, so the file belongs in **`apps/api/.env`**. The Compose credentials are public local demo defaults. Environment files are ignored by Git.

### 2. Start PostgreSQL, migrate, and seed

```sh
docker compose up -d --wait postgres
npm run db:migrate -w @ticketflow/api
npm run db:seed -w @ticketflow/api
```

Migration files are versioned in [apps/api/drizzle](apps/api/drizzle). The seed creates five events with 16 ticket types:

| Event | Ticket types and sample prices (EUR) |
| --- | --- |
| F1 GP Bahrain | VIP: 600; Prestige: 350; Standard: 150 |
| F1 GP Malaysia | VIP: 500; Prestige: 250; Standard: 100 |
| F1 GP Monza | VIP: 900; Prestige: 500; Standard: 200 |
| MotoGP GP Mugello | VIP: 400; Roof: 180; Grass: 80 |
| UEFA Champions League Semi-Final Berlin | Central Area A: 300; Central Area B: 220; Home: 120; Visitors: 120 |

Dates in 2027, prices, capacities, and event descriptions are illustrative demo data, not official schedules or offers. Edit them in [apps/api/src/db/seed.ts](apps/api/src/db/seed.ts); `priceCents` is expressed in cents (for example, `15000` means EUR 150).

Run the seed once on a fresh development database. It inserts new records on every execution and is not idempotent; rerunning it duplicates the sample events. The development database uses a persistent Docker volume.

### 3. Start the application

In one terminal:

```sh
npm run dev:api
```

In another terminal, also from the repository root:

```sh
npm run dev -w apps/web
```

Open **http://localhost:5173**. Vite proxies `/api` requests to Fastify at `http://localhost:3000`. The API listens on `0.0.0.0:3000`; keep the demo in a trusted local environment.

To check that the HTTP server responds:

```sh
curl http://localhost:3000/health
```

The health route returns `{"status":"ok"}`. It does not test database connectivity; loading the event catalog exercises the database path.

### Build and run the API

```sh
npm run build -w @ticketflow/api
npm run build -w apps/web
npm run start -w @ticketflow/api
```

The builds produce `apps/api/dist` and `apps/web/dist`. A deployment must serve the frontend assets and route `/api` to the API on the same origin, or explicitly configure an alternative. The Vite development proxy is not a production hosting setup. Docker Compose currently provisions PostgreSQL only, not application containers.

## Trying the demo

1. Select an event and reserve tickets as Visitor A. Observe the reservation in **My Orders**.
2. Add or switch to Visitor B in the header. Visitor B has a separate order list and sees inventory reduced by A's reservation when availability refreshes.
3. Return to Visitor A and confirm the booking. The inventory moves from reserved to sold and the order becomes `CONFIRMED`.
4. Leave another reservation pending to explore expiration. Cleanup eventually marks it `EXPIRED` and releases inventory; confirmation independently checks the deadline even before cleanup runs.

Use separate browser profiles or isolated browser sessions when exploring simultaneous visitors in different windows. Visitor identities are stored in localStorage, which normal tabs for the same origin share. Switching visitors sequentially is useful for understanding behavior, but does not demonstrate concurrent correctness; the database tests exercise parallel requests.

## Architecture

The repository is an npm workspace monorepo with separate API and web applications. This keeps dependency installation and local checks together while leaving application code in distinct workspaces.

```mermaid
flowchart LR
    UI[React browser UI] -->|HTTP /api| API[Fastify routes and JSON schemas]
    API --> Services[Event and order services]
    Cleanup[Server cleanup or manual command] --> Services
    Services -->|Drizzle and SQL transactions| DB[(PostgreSQL 17)]
```

| Area | Responsibility | Main location |
| --- | --- | --- |
| API composition | Fastify instance, route registration, health endpoint | [apps/api/src/app.ts](apps/api/src/app.ts) |
| Server lifecycle | Listening, periodic cleanup, signal handling, pool shutdown | [apps/api/src/server.ts](apps/api/src/server.ts) |
| Order workflows | Inventory reservation, idempotency, confirmation, expiration | [apps/api/src/modules/orders](apps/api/src/modules/orders) |
| Persistence | Drizzle schema, PostgreSQL pool, seed and SQL migrations | [apps/api/src/db](apps/api/src/db) |
| Cleanup orchestration | Bounded backlog cycles shared by server and command | [apps/api/src/jobs/expiration-cleanup.ts](apps/api/src/jobs/expiration-cleanup.ts) |
| Frontend | React views, simulated visitors, request lifecycle handling | [apps/web/src](apps/web/src) |
| Checkout recovery | Validated sessionStorage requests and original retry keys | [apps/web/src/lib/checkout-storage.ts](apps/web/src/lib/checkout-storage.ts) |

The API uses TypeScript, Fastify, Drizzle, and `pg`. The frontend uses React, Vite, Tailwind CSS v4, and LESS. PostgreSQL provides the transaction and locking semantics used by the order workflows.

### Data model

| Entity | Purpose |
| --- | --- |
| `events` | Event metadata and start time |
| `ticket_types` | Event-specific capacity, price, reserved quantity, and sold quantity |
| `orders` | Visitor, idempotency key, status, total, deadline, and confirmation time |
| `order_items` | Requested quantities and the unit prices captured for the order |
| `tickets` | One issued record per confirmed ticket, including purchase price |

Availability is derived as `capacity - reserved_quantity - sold_quantity`. Database checks prevent negative inventory and quantities beyond capacity. Unique indexes enforce one order per visitor/idempotency key and one order item per ticket type within an order.

Prices are stored as integer cents to avoid floating-point money calculations. Order items retain the selected server price, so confirmation uses the purchase snapshot. The demo UI displays EUR; there is no multi-currency model.

### API surface

| Method | Route | Behavior |
| --- | --- | --- |
| GET | `/health` | HTTP liveness response |
| GET | `/api/events` | List events |
| GET | `/api/events/:id` | Event detail and current ticket availability |
| POST | `/api/orders` | Create or replay a reservation |
| POST | `/api/orders/:id/confirm` | Confirm an order and issue ticket records |
| GET | `/api/orders?visitorId=<uuid>` | List that visitor's order summaries |

Order creation accepts `visitorId`, `idempotencyKey`, `eventId`, and `items: [{ ticketTypeId, quantity }]`. UUIDs, 1-20 items, and integer quantities from 1 to 100 are validated at the HTTP boundary. Duplicate ticket types are rejected by the service. Client prices, totals, and availability are never authoritative.

Creation returns HTTP **201**, including for an idempotent replay. Confirmation returns **200**. Domain errors use `{ "error": "..." }`; validation failures use Fastify's standard **400** response. Relevant domain failures include missing events/orders (**404**), insufficient availability, conflicting idempotency payloads, and expired confirmations (**409**).

Ticket records are written to the database but are not returned by confirmation or exposed through a ticket retrieval route.

## Design choices and rationale

### Atomic inventory reservations

Reading availability and later writing a reservation would allow two requests to purchase the same last ticket. Instead, each ticket type is updated with one conditional SQL statement: increment reserved quantity only when enough inventory remains. PostgreSQL checks the condition while coordinating concurrent updates.

The full order is created in a transaction. If any item cannot be reserved, earlier reservations roll back with it. Ticket types are processed in deterministic ID order to reduce deadlock risk for orders containing multiple types. Database constraints provide a second line of protection against invalid inventory.

This puts coordination in PostgreSQL, where multiple API processes share the same state, without requiring an application-wide mutex or an additional locking service.

### Idempotency is a server and client responsibility

The server serializes requests sharing a visitor and idempotency key using a PostgreSQL advisory transaction lock. It checks the existing order before reserving inventory. The unique index is the database backstop.

- Same key and same event/items/quantities: return the existing order.
- Same key and different order data: reject with **409**.
- New key: a new reservation attempt.

The frontend saves the original request in sessionStorage **before sending it**. If the server commits but the response is lost, retry uses that exact payload and key. Generating another key could create a second reservation.

An uncertain attempt remains recoverable even when refreshed availability is zero: its own reservation may have consumed the remaining stock. Quantity controls stay locked until the attempt resolves. Explicit 400/404/409 responses clear the attempt; network failures, timeouts, rate limits, server errors, and response JSON parsing failures retain it for manual retry.

Storage is versioned, validated, and scoped by visitor and event. Reloading or returning to the event restores the attempt. Saving failures prevent the initial POST, rather than starting a request that cannot be recovered after a reload. sessionStorage keeps this recovery local to a tab session instead of retaining unresolved checkout state indefinitely across browser sessions.

### Confirmation and expiration share the same order lock

Both operations acquire `SELECT ... FOR UPDATE` on the order row. Repeated confirmation returns the confirmed order without issuing more tickets. Expiration changes only pending, expired orders and releases inventory once.

When confirmation discovers an expired order, the transaction commits the inventory release and expired status **before** the service reports a 409. Throwing inside that transaction would roll back the release.

Deadlines are calculated using database time. The current implementation uses transaction-start `now() + interval '10 minutes'` when creating a reservation, and **`clock_timestamp()` after acquiring the row lock** when checking expiry. A transaction can wait past the deadline; comparing against its original `now()` would incorrectly treat the order as still valid.

Confirmation transfers reserved inventory to sold inventory and creates one ticket record per quantity in the same transaction. There is no external payment operation to coordinate in this demo.

### Bounded cleanup instead of a separate worker system

The server performs a cleanup cycle after listening and then every 30 seconds. The shared backlog function processes at most **10 batches of 100 selected orders** per default cycle, stopping sooner on no progress or shutdown. A partial expired count does not imply that the backlog is empty, because another instance may have processed some of the selected rows.

The batch budget bounds work per cycle, while subsequent cycles handle remaining backlog. A shared in-flight promise prevents overlapping cycles within one server process. Keeping the scheduler in the API avoids introducing a queue or another service for the demo; the tradeoff is eventual expiration and scheduler availability tied to the API process.

For manual processing against the configured API database:

```sh
npm run orders:expire -w @ticketflow/api
```

The command uses the same bounded cycle and closes its pool. If it reaches the batch limit, it reports that it should be run again. It does not promise to drain an arbitrary backlog in one invocation.

On SIGINT/SIGTERM, the server stops scheduling cleanup, closes Fastify, waits for requests and the current cleanup batch, and then closes the PostgreSQL pool. Repeated signals share the same shutdown operation. Shutdown does not cancel an inventory transaction midway.

### Simulated visitors instead of login

The visitor switcher is an intentional demonstration and testing aid. UUID-backed visitors make it quick to reserve as one actor, switch to another, inspect separate order lists, and test UI changes while requests are still in flight. localStorage retains these identities between reloads.

A real login flow would introduce password handling, account verification, sessions, and authorization policies without establishing whether inventory, idempotency, or expiration work correctly. Those concerns were kept outside this project's current focus.

This choice deliberately removes a security boundary: a supplied `visitorId` is not verified, and confirmation accepts an order ID without an ownership check. Real authentication and server-side ownership enforcement would be required before exposing private order data or booking actions to untrusted users. Hiding an order in the UI is not access control.

### Explicit frontend request ownership

The UI uses fetch, AbortController, refs, and React state rather than adding a global store or a data-fetching framework for a small set of views. Superseded requests are aborted and their results are also checked for relevance, because cancellation alone does not guarantee that every late callback disappears.

Checkout state is scoped by event and visitor; My Orders state is scoped by visitor. Keyed internal components initialize a new view when that identity changes. Late reads and confirmations cannot update the replacement view. Polling runs while the tab is visible, and temporary refresh failures retain already loaded data.

The tradeoff is explicit lifecycle code that needs race-focused tests. Browser availability and expiration display are informational: the backend rechecks inventory and deadlines for every state-changing workflow.

## Testing strategy

### Prepare the dedicated database

Install dependencies first, then run these commands from the root:

```sh
docker compose up -d --wait postgres-test
DATABASE_URL='postgresql://ticketflow:ticketflow@localhost:5433/ticketflow_test' \
  npm run db:migrate -w @ticketflow/api
```

The URL assignment applies only to that migration command; it does not replace your development `.env`. Migration commands do not automatically select the Vitest database, which is why the explicit URL matters.

The test PostgreSQL instance uses tmpfs. Its data is ephemeral: after stopping or recreating that container, rerun migrations before the tests. Do not seed it; tests create their own fixtures.

### Run checks

```sh
npm run test -w @ticketflow/api
npm run typecheck -w @ticketflow/api
npm run build -w @ticketflow/api
npm run test -w apps/web
npm run lint -w apps/web
npm run build -w apps/web
```

At the latest verified checkpoint, **60 backend tests and 62 frontend tests passed**, both builds passed, the API typecheck passed, and frontend lint passed. These results are a checkpoint, not a claim of complete coverage or a substitute for rerunning checks after changes.

### Why real PostgreSQL for the order tests?

The important behavior depends on PostgreSQL transactions, conditional updates, advisory locks, row locks, and database clocks. An in-memory repository or mocked ORM cannot establish whether those mechanisms prevent overselling or double release.

[orders.test.ts](apps/api/src/modules/orders/orders.test.ts) therefore uses the dedicated PostgreSQL database and checks persisted orders, inventory, and ticket counts. It covers concurrent reservations, rollback after an earlier reservation succeeds, creation idempotency, contending confirmations, expiration, and bounded cleanup across cycles. HTTP validation cases use Fastify's `app.inject()` without binding a network port.

Expiration fixtures set `expiresAt` directly in the test database, avoiding ten-minute waits. The lock-wait regression holds an order row lock, observes the blocked transaction using `pg_blocking_pids()`, updates the deadline during the wait, and releases the lock after database time has passed it. This reproduces the transaction-start-clock problem without arbitrary sleeps.

Vitest fixes `DATABASE_URL` to local `ticketflow_test` on port 5433. The database client rejects unexpected hosts, ports, or database names during tests. Compiled `dist` tests are excluded so stale generated tests do not run alongside source files.

Test files run sequentially. Fixtures remain in the test database, and batch tests process older expired test reservations before exact-count assertions; use this database exclusively during a suite run. File-level serialization does not remove concurrency inside the reservation tests, which launch competing operations explicitly.

### Why mocks for scheduler and frontend tests?

Scheduler and lifecycle tests need to control batch results, time, signals, startup, and failures precisely. They mock Fastify, pool operations, and batch calls where appropriate, and invoke captured signal callbacks rather than terminating the test process. A database integration test separately verifies that bounded cycles release actual inventory correctly.

Frontend tests render React components in jsdom and control fetch responses, including deferred and out-of-order completions. This makes response loss, failed refreshes, visitor switching, storage failures, restored attempts, and duplicate clicks reproducible. Fake timers verify visible-tab polling, deadline display updates, and cleanup without waiting in real time. StrictMode restoration is also tested.

The visitor switcher supports manual exploration; automated tests create distinct identities and control requests directly. UI simulation and database concurrency testing serve different purposes.

### Test locations

| File | Main coverage |
| --- | --- |
| [orders.test.ts](apps/api/src/modules/orders/orders.test.ts) | Database workflows, concurrent operations, clock regression, HTTP input validation |
| [server.test.ts](apps/api/src/server.test.ts) | Shutdown, startup races, scheduler overlap, backlog continuation |
| [expiration-cleanup.test.ts](apps/api/src/jobs/expiration-cleanup.test.ts) | Batch limits, partial/no progress, shutdown checks, failures |
| [expire-orders.test.ts](apps/api/src/jobs/expire-orders.test.ts) | Manual command output and resource handling |
| [EventDetail.test.tsx](apps/web/tests/EventDetail.test.tsx) | Checkout recovery, storage, stale requests, polling, StrictMode |
| [MyOrders.test.tsx](apps/web/tests/MyOrders.test.tsx) | Visitor isolation, refresh/confirmation races, error handling, display clock |

## Limits and production considerations

| Current limit | Consequence and next consideration |
| --- | --- |
| Simulated identity; no authentication or ownership checks | Order data and actions are not protected from untrusted clients. Real identity and authorization must be designed together. |
| No payment processing | Confirmation is a demo operation, not evidence that payment succeeded. A real payment flow needs its own idempotency and failure handling. |
| No ticket retrieval, cancellation, refunds, or check-in | Tickets are database records only. `CANCELLED` exists in the enum but has no implemented cancellation workflow. |
| Eventual cleanup with a finite batch budget | Expired reservations can temporarily reduce displayed availability. Sustained backlog can outpace cleanup; confirmation still enforces the deadline independently. |
| In-process scheduling and duplicate scans across instances | Locks protect state transitions, but there is no dedicated worker coordination or `SKIP LOCKED` processing. A production scheduler needs a deliberate ownership and capacity strategy. |
| No shutdown deadline or database lock-wait timeout | An indefinitely blocked operation can delay termination. The batch budget limits counts, not elapsed time. Timeout and forced-exit policies remain an explicit design decision. |
| Tab-session checkout persistence | Closing the tab or clearing storage can lose the recovery key. The order may still be found in My Orders for the same visitor. Reload does not automatically navigate back to the event. |
| Client-clock display and periodic availability | My Orders updates its display clock each second while pending orders exist, but clock skew can still affect button visibility. API time and inventory remain authoritative. |
| Mostly compile-time frontend response typing | Stored requests are validated, but API responses do not have complete runtime schema validation. |
| Incomplete end-to-end coverage | There are no real-browser full-stack tests or real subprocess signal tests. Valid HTTP order lifecycles and application error mappings need more route-level coverage; expired-order race tests do not force both row-lock acquisition orders. |
| Local deployment defaults | Compose contains local credentials, `/health` is liveness only, and there is no production application hosting configuration. Deployment hardening, secrets, readiness, and operational monitoring require separate work. |

The current priority is a reviewable reservation workflow with explicit correctness guarantees and known boundaries. A production ticketing service would need the missing access control, payment, ticket lifecycle, and operational capabilities before public use.

## Repository notes

- [docs/PROJECT_CONTEXT.md](docs/PROJECT_CONTEXT.md) contains the detailed implementation handoff and remaining work.
- [AGENTS.md](AGENTS.md) records repository-specific development conventions.
- The API keeps TypeScript 7 for compilation. Shared compiler-API tooling uses TypeScript 6 at the root, matching the frontend tooling: hoisted `ts-api-utils` must not resolve TypeScript 7's version-only main export. Keep this distinction when updating dependencies.
- Migration generation is available through `npm run db:generate -w @ticketflow/api`; use it for reviewed schema changes, not as a substitute for applying existing migrations during installation.
- Do not commit environment files, credentials, or generated build output.
