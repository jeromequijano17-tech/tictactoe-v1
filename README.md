# Gridline — online Tic-Tac-Toe

A Node.js, Socket.IO, and MySQL multiplayer game. The server owns room membership, turns, clocks, match results, ratings, XP, missions, and achievement awards. The browser is a responsive HTML/CSS/JavaScript client; it never submits a claimed winner.

## Included

- Guest casual play, registered accounts, session-backed login/logout, password reset by SMTP, and opt-in import of completed guest history.
- Private room codes/invite links, in-process casual/ranked matchmaking, reconnect grace periods, X/O assignment, server-validated turns, optional per-turn clocks, rematches, forfeit handling, and read-only spectators by active room code.
- 3×3, 4×4, and 5×5 boards with three-in-a-row wins; local easy, tactical, and minimax-perfect 3×3 AI practice.
- Ranked accounts, all-time and rolling day/week/month leaderboards, profile stats, paginated match history, and move-by-move replays.
- Friend requests/search, match chat, four quick reactions, mute, player reports, a role-protected moderation view, audit records, daily mission claims, and server-awarded achievements.
- MySQL schema/seed data, database-backed sessions, security headers, CSRF checks for state-changing HTTP requests, origin checks, request/socket rate limits, and database transactions around account/result/reward changes.

The following larger-product features are not implemented yet: email verification, social-account providers, seasonal rating snapshots, avatar/theme/symbol unlock inventory, configurable achievement/mission administration, tournament registration/bracket advancement, account deletion, and a configurable admin UI for reward definitions. Friend challenges share a private room link rather than delivering a direct in-app challenge notification. Do not advertise those as available. The Socket.IO room and matchmaking state is process-local; run one app instance. Restarted waiting/active matches are marked abandoned. Use a shared adapter/state service and coordinated result persistence before horizontal scaling.

## Requirements

- Node.js 20 or newer (tested with Node 24).
- MySQL 8.0 or newer (the schema uses MySQL 8 collations and checks).
- Docker Compose for the quick local setup, or a reachable MySQL server for manual setup.

## Local development with Docker

1. Copy `.env.example` to `.env` and replace `SESSION_SECRET`, `DB_PASSWORD`, and `DB_ROOT_PASSWORD` with different random values. For example, generate values with `openssl rand -hex 32`; never commit `.env`.
2. Keep the local defaults `APP_ORIGIN=http://localhost:3000` and `COOKIE_SECURE=false` for this HTTP-only development setup.
3. Run `docker compose up --build`.
4. Open `http://localhost:3000`. MySQL initializes `src/db/schema.sql` on the first empty data volume. The app waits for the database health check.

To stop, run `docker compose down`. To preserve local data, do not remove the `mysql-data` volume. To deliberately reset it, run `docker compose down -v` (this deletes the local database).

## Manual setup

Create a MySQL database and least-privilege application user, then grant that user access to the application schema:

```sql
CREATE DATABASE tictactoe CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER 'tictactoe_app'@'%' IDENTIFIED BY 'use-a-long-unique-secret';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES ON tictactoe.* TO 'tictactoe_app'@'%';
```

Copy `.env.example` to `.env`, set the database host/name/user/password and a random `SESSION_SECRET` (at least 32 characters), then run:

```sh
npm ci
npm run db:init
npm run dev
```

For password recovery, configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, and `SMTP_FROM`. Recovery deliberately returns a setup error if SMTP is absent; it does not print reset tokens into logs or responses. Without mail service, the reset email flow is unavailable.

The first administrator must be promoted by an authorized database operator after registering:

```sql
UPDATE users SET role = 'admin' WHERE username_normalized = 'your_username';
```

Sign out and back in after promotion so the new session reflects the role. Admin access is checked against the database on requests and Socket.IO connection establishment.

## Tests

`npm test` runs the database-free game rules tests. The MySQL integration test is skipped unless explicitly enabled. With the schema loaded and disposable test database credentials in `.env`, run:

```sh
npm run test:integration
```

The integration test starts a separate server, creates uniquely named test accounts, verifies login/logout and CSRF/authorization boundaries, connects two sockets, checks turn rejection and a ranked win, and verifies the persisted replay/rating. It leaves test accounts and match records in the configured database; use a disposable database. Do not point it at production.

Health probe: `GET /api/health` checks the database connection. `/api/admin/overview`, `/api/admin/users`, and moderation operations require an administrator session.

## Production deployment

1. Push this repository to GitHub and connect it to a Node.js host that supports long-running Node processes and WebSocket upgrades. Provision a managed MySQL 8 database separately; confirm its backup/retention policy and connection limits.
2. Configure the host with `NODE_ENV=production`, `APP_ORIGIN=https://your-real-domain`, a unique random `SESSION_SECRET`, `COOKIE_SECURE=true`, and the provider's private MySQL connection values. Configure SMTP if password resets are required. Set `TRUST_PROXY=true` only when the app is behind the provider's trusted proxy.
3. Run `npm ci` during build and `npm start` as the process command. Apply `src/db/schema.sql` once through a controlled migration/initialization step using a database principal allowed to create tables. The application database principal needs session-table creation on first boot; restrict later privileges if your deployment manages that table separately.
4. Terminate TLS at the host/proxy and forward WebSocket upgrades. Set the exact public HTTPS origin in `APP_ORIGIN`, allow that origin in any outer proxy, and keep database traffic private/TLS-protected where supported.
5. Start with one app instance. Room, matchmaking, timers, and reconnect state are in memory; sticky routing alone does not share those maps. Multi-instance deployment requires a shared Socket.IO adapter and durable/shared room state, coordinated timers, and migration tests first.

No hosting provider or persistent free tier is assumed. Review host-specific port, proxy, TLS, outbound SMTP, MySQL TLS, backup, and sleep/idle policies before launch. `COOKIE_SECURE` cannot be disabled in production by setting it false; use HTTPS.

## Security and operations notes

- Passwords use bcrypt with 12 rounds; the HTTP-only session cookie is SameSite=Lax and Secure in production. Sessions expire after 24 hours of inactivity and roll on use.
- State-changing HTTP endpoints require a session CSRF token and reject foreign origins. Socket.IO checks the configured origin and uses the HTTP session. Password reset tokens are random, stored as SHA-256 digests, expire in one hour, are one-use, and invalidate existing sessions.
- Inputs are bounded and parameterized; chat is rendered with text nodes, capped at 280 characters, and rate-limited. HTML sent in chat remains text. Ranked access is account-only; guests never enter rated matchmaking.
- A ranked win/loss changes rating by a fixed 16 points; draws do not. Ranked forfeits count as a loss for the player who left. A completed game is persisted once under a guarded status update. Disconnections get the configured reconnect grace period; expiry forfeits. Draws change no rating. Restarted unfinished matches are abandoned and do not award rating or XP.
- The rolling leaderboard windows use completed ranked match records. All-time rating and profile totals come from `player_stats`, updated in the result transaction. Database failures are returned/logged rather than treated as successful moves/results.
- The project has no email verification, abuse automation, independent security assessment, production load test, or multi-instance state adapter. Set up backups, monitoring/alerting, log retention, SMTP reputation controls, and an incident process before public launch.

## Troubleshooting

- **Database connection fails:** check `DB_HOST` (use `db` inside Compose, not `127.0.0.1`), port, account grants, and that MySQL is healthy. Run `npm run db:init` for a manually managed database.
- **Invite links fail:** the room exists only while its hosting app process is running and waiting for its second player; check the exact `APP_ORIGIN` and ensure both clients reach the same app instance.
- **Session/auth loops:** use the exact `APP_ORIGIN`, allow cookies/credentials at the proxy, keep HTTPS and `COOKIE_SECURE=true` together in production, and ensure the session table user has required access.
- **WebSocket stays disconnected:** allow WebSocket upgrade headers and the configured origin through the reverse proxy; keep HTTP long-polling available if the host blocks direct WebSockets.
- **Password reset unavailable:** configure SMTP values and verify outbound SMTP/TLS access. The request endpoint reports when the mailer is not configured.
- **Schema changed:** the SQL initializer uses `CREATE TABLE IF NOT EXISTS` for first-time setup, not a versioned migration engine. Back up the DB and apply reviewed additive migrations for future schema changes; do not assume rerunning it alters existing tables.