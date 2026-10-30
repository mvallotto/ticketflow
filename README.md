# TicketFlow

TicketFlow is a web app for booking tickets for sports events. Visitors can browse events, choose a ticket category, reserve tickets and confirm their booking. Each visitor has an order list where they can find pending and confirmed reservations.

The main focus is what happens behind the checkout: two people trying to reserve the last ticket, a request being sent twice, or a reservation expiring while someone is confirming it.

## Run locally

You need Node.js, npm and Docker with Docker Compose. The project was developed with Node.js 26 and npm 11, using WSL2 Ubuntu on Windows.

Run the following commands from the repository root in a Bash terminal.

### Install dependencies

```sh
npm ci
cp .env.example apps/api/.env
```

The API reads its configuration from `apps/api/.env`. If you already have that file, keep it rather than copying over it. The default connection is:

```dotenv
DATABASE_URL=postgresql://ticketflow:ticketflow@localhost:5432/ticketflow
```

### Set up the database

```sh
docker compose up -d --wait postgres
npm run db:migrate -w @ticketflow/api
npm run db:seed -w @ticketflow/api
```

The seed adds five events: the F1 GPs in Bahrain, Malaysia and Monza, the MotoGP GP at Mugello, and a Champions League semi-final in Berlin. Each event has its own ticket categories, prices and available quantities. You can change them in [seed.ts](apps/api/src/db/seed.ts). Prices are stored in cents: `15000` means EUR 150.

Run the seed once on a fresh database. Running it again adds another copy of the events. The development database keeps its data in a Docker volume.

### Start the API and frontend

In one terminal:

```sh
npm run dev:api
```

In another:

```sh
npm run dev -w apps/web
```

Open **http://localhost:5173**. The frontend runs on port 5173 and forwards `/api` requests to the API on port 3000. PostgreSQL uses port 5432; the separate test database uses port 5433.

## Architecture

The project is an npm workspace monorepo with two applications:

```text
apps/api
  src/db              Database schema, connection and seed
  src/modules/events  Event routes and queries
  src/modules/orders  Reservations, confirmation and expiration
  src/jobs            Expired-order cleanup
  drizzle             Database migrations
apps/web
  src/components      Catalog, checkout and order views
  src/contexts        Simulated visitors
  src/lib             API calls and saved checkout requests
  tests               Frontend tests
```

The backend uses Fastify, TypeScript, PostgreSQL and Drizzle. Routes validate HTTP input, while services handle reservations and database transactions. Drizzle keeps the schema and queries close to TypeScript, with SQL used directly where locking and inventory updates need it.

The frontend uses React and Vite. Component styles are written in LESS, with shared colors in `src/styles/variables.less`; Tailwind supplies the base CSS reset. It calls the API with fetch and keeps state inside the views. There is no global state library: for the current number of screens, local state and context are enough. This keeps dependencies down, but means request cancellation and late responses need to be handled explicitly.

The database stores events, ticket types, orders, order items and issued tickets. Ticket types track capacity, reserved quantity and sold quantity. Availability is calculated from those values. Order items also keep the price used when the reservation was created.

## How reservations work

### Reserving tickets

The visitor chooses quantities and submits an order. The backend reads the prices from the database, calculates the total and reserves the tickets for ten minutes. The order starts as `PENDING`.

The inventory update succeeds only if enough tickets remain. The check and update happen in the same SQL statement, so two requests cannot both reserve the same last ticket. All items belong to one transaction: if one category is unavailable, the whole reservation is rolled back.

Prices use integer cents to avoid floating-point calculations. The frontend shows the total, but the server calculates the amount used for the order.

### Retrying a checkout

Each checkout attempt has an idempotency key. Sending the same order with the same key returns the existing reservation. Reusing the key with different quantities or a different event returns a conflict.

This matters when the server creates an order but the browser never receives the response. The frontend saves the original request in sessionStorage before sending it. After a network error or reload, the visitor can retry with the same key and quantities instead of creating a second order.

A retry is allowed even if availability has dropped to zero, since the original reservation may have taken those tickets. The selection stays locked until that attempt is resolved.

### Confirming or expiring an order

Confirmation moves inventory from reserved to sold, creates ticket records and marks the order as `CONFIRMED`. Confirming the same order again does not issue more tickets.

Confirmation and expiration both lock the order row. Only one can change it at a time, which prevents inventory from being released twice or an expired order from being confirmed by a competing request. Expiration checks use the current database time after acquiring the lock, including time spent waiting for it.

A cleanup job runs when the API starts and every 30 seconds afterward. Each cycle processes up to ten batches of 100 orders. Keeping this inside the API avoids adding another service, but expired reservations may continue to hold inventory until cleanup runs. Confirmation checks the deadline itself, so it does not depend on that job running first.

You can also run cleanup manually:

```sh
npm run orders:expire -w @ticketflow/api
```

The command uses the same batch limit and tells you if it needs to be run again. On SIGINT or SIGTERM, the server stops scheduling cleanup, waits for active requests and cleanup, then closes the database connection pool.

## Why visitors instead of login?

The header lets you add and switch between visitors. For example, you can reserve tickets as Visitor A, switch to Visitor B and see how the availability and order list differ. Visitors are saved in localStorage so they survive a reload.

This was a way to make the booking flow easy to try without spending time on accounts, passwords and sessions. The work went into inventory, retries and expiration instead. There is no real authentication or order ownership check on the server, so this would need to change before supporting real users.

For simultaneous visitors in separate windows, use different browser profiles or isolated sessions. Normal tabs share localStorage. Switching visitors is useful for trying the interface; the automated database tests check actual concurrent requests.

## Testing

### Set up the test database

```sh
docker compose up -d --wait postgres-test
DATABASE_URL='postgresql://ticketflow:ticketflow@localhost:5433/ticketflow_test' \
  npm run db:migrate -w @ticketflow/api
```

The test database is separate from development. The URL above applies only to the migration command. Vitest then selects the test database automatically, and the database client rejects unexpected database URLs during tests.

The test container stores its data in memory. After stopping or recreating it, run the migrations again. Tests create their own data, so no seed is needed. Fixtures remain between runs; use this database for one backend test run at a time.

### Run the checks

```sh
npm run test -w @ticketflow/api
npm run typecheck -w @ticketflow/api
npm run test -w apps/web
npm run lint -w apps/web
```

Backend tests use Vitest and real PostgreSQL for order workflows. Mocking the database would not show whether row locks, transactions and concurrent updates work as intended. Tests check the stored orders, inventory and tickets after each operation, including attempts to reserve the last ticket and confirm the same order concurrently.

Expiration tests set the deadline directly in the test database instead of waiting ten minutes. One test holds a row lock while another operation waits, then moves the deadline to check what happens when the lock is finally released. HTTP validation is tested through Fastify's `app.inject()`.

Cleanup and shutdown tests use mocks and controlled timers. This makes it possible to check signals, failures and repeated shutdown requests without stopping a real process.

Frontend tests use Vitest and jsdom. They simulate network failures and responses arriving in the wrong order, check visitor changes, and verify that a saved checkout can be recovered. Timers are controlled so polling and expiration display can be tested without real waits.

## Build

```sh
npm run build -w @ticketflow/api
npm run build -w apps/web
```

The output is written to `apps/api/dist` and `apps/web/dist`. To run the compiled API:

```sh
npm run start -w @ticketflow/api
```

For deployment, the frontend needs a static server that forwards `/api` to the backend. Docker Compose currently runs PostgreSQL only.

## Current limits and tradeoffs

- **No payments or full ticket management.** Confirmation is a booking action. Tickets are stored in the database, but there is no ticket download, check-in, cancellation or refund flow.
- **Cleanup runs with the API.** It stops when the API is down, and a large backlog can take several cycles. Multiple API instances may scan the same orders, although database locks protect the updates. A separate worker would be a next step if the workload grows.
- **Shutdown has no timeout.** The server waits for current work to finish. A blocked database operation can keep it waiting indefinitely.
- **Checkout recovery lasts for the tab session.** Closing the tab or clearing storage can lose the saved request. Existing orders can still be found in My Orders if the visitor identity is retained.
- **Browser data can be out of date.** Availability refreshes periodically, and the displayed deadline uses the browser clock. The backend always checks inventory and expiration again.
- **Frontend response validation is limited.** Stored checkout requests are validated, but most API responses rely on TypeScript types rather than runtime checks.
- **There are no full browser tests yet.** Component tests simulate the network, and shutdown tests simulate signals. Testing the whole app in a browser and sending signals to a real server process would cover the remaining integration gaps.
