# Deployment and recovery runbook

Phase 11 prepares a single-server Linux release with Node 24, PostgreSQL 18,
Caddy HTTPS/static hosting and systemd supervision. This is a local preparation
baseline; no host/domain has been selected and no live release is authorized by
these example commands. Replace example names and verify paths on the selected host.

## Build a release

Run backend checks, database regressions and frontend build first (README). Then:

```bash
bash deploy/package-release.sh /tmp/salon-release.tgz
```

The archive uses an explicit allowlist: compiled API/workers/bootstrap, frontend
assets, package locks, Prisma schema/migrations/config, deployment files and docs.
It includes current working-tree changes. It excludes `.env`, credentials,
development seed data, node_modules and Git metadata. Store its SHA-256 and the
reviewed source commit/working-tree provenance with the release. Commit and review
all intended files before a real release; a prior CI run cannot certify uncommitted work.

On the target host, install supported Node 24 at `/usr/bin/node`, PostgreSQL 18
client tools, Caddy and systemd through the host's trusted package sources. Create
a dedicated unprivileged `salon` OS account. Unpack into a new root-owned directory
such as `/opt/salon/releases/RELEASE_ID`, readable by salon and Caddy. Never unpack
over the running release. In its `backend/`, run `npm ci --include=dev` to retain
the pinned Prisma migration CLI. The package has compiled Prisma client code, so
startup requires no generation. Keep dependencies installed on the target OS/CPU
(bcrypt is native); do not copy a workstation's node_modules.

Create `/etc/salon/salon.env` from `deploy/production.env.example`, root-owned mode
0600; systemd reads it before switching to the salon account. Use a secrets manager
or secure editor. Generate a unique high-entropy JWT secret, configure the exact
HTTPS origin, and use a dedicated non-superuser database role/database with only
its application schema privileges. Apply verified TLS/CA settings for remote
PostgreSQL. Never disable certificate verification. Keep DB port private and
API HOST=127.0.0.1. Do not store bootstrap credentials in the persistent service file.

## Migrations and first Admin

Back up before migration. Stop the API and both workers during incompatible updates.
Using the release backend and securely injected DATABASE_URL, run:

```bash
npm run db:migrate
npm run db:status
```

Never use `db push`, `migrate reset`, or the development seed on production.
The first installation starts empty. Securely inject these one-time variables:
`BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD`, `BOOTSTRAP_ADMIN_FIRST_NAME`,
`BOOTSTRAP_ADMIN_LAST_NAME`, together with the normal production environment. Then:

```bash
npm run admin:bootstrap
```

The command validates the existing account rules (12+ characters, at most 72 UTF-8
password bytes), hashes the password, and atomically creates one Admin and a SYSTEM
audit event. It requires an entirely empty User table and serializes concurrent
runs. It cannot reset passwords, create a second user, or populate salon fixtures.
Remove those four bootstrap variables immediately afterward. Initial Admin login
then configures profile, real services, staff, qualifications/commission rates,
hours, schedules and the effective booking policy, and creates Cashier accounts.
Salon staff review these values before opening booking.

## Start and route traffic

Point `/opt/salon/current` at the prepared release. Install `deploy/salon@.service`
in `/etc/systemd/system/`, check `/usr/bin/node`, and run `systemd-analyze verify`.
The three supported instance names map to compiled entry points:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now salon@server salon@hold-worker salon@notification-worker
sudo systemctl status salon@server salon@hold-worker salon@notification-worker
```

Edit the Caddyfile domain and install it using the host's Caddy service convention.
Verify DNS, public ports 80/443, certificate issuance/renewal and Caddy's read access
to the release path. Run `caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`
before reloading. `/api/*` preserves the path and browser Origin; other paths serve
the built frontend with SPA fallback. No development Vite server is used in release.
The example deliberately does not enable access logging of private request URLs.
API logs are structured and omit request bodies/credentials. Review any host logging
configuration for cookies, private links, payment data and retention before enabling it.

Probe `/api/health` for process liveness and `/api/ready` for database/schema access.
Readiness checks access to the User table; it does not certify every migration or
provider. A failed check returns 503 without database details. Use a bounded monitor
request timeout and check `db:status` separately. Verify direct navigation to
`/availability`, `/appointment`, `/help`; verify login/logout, secure HttpOnly cookies,
exact origin rejection and Admin/Cashier boundaries over the actual HTTPS origin.

## Provider release acceptance

The example disables online payment and outbound notifications. This permits manual
collection workflows but does not certify a release requiring online payments/messages.
Do not select `test` in production; environment validation rejects it.

For PayMongo, complete `PAYMONGO_SANDBOX_VALIDATION.md`, then configure the chosen
merchant's live key, webhook secret and HTTPS `/appointment` return URL. Validate
signed events, capture identity/amount, duplicate delivery, expiration, late capture
and reconciliation using approved merchant procedures. Never record a provider
capture again as a manual collection. See the README for webhook endpoint details.

For Gmail/PhilSMS, complete account/App Password/sender setup, observe delivery and failure
handling with salon-authorized recipients, and approve wording/timezone/reminder
settings. Provider acceptance is not proof of inbox/handset delivery. Record evidence
in ACCEPTANCE_BACKLOG A04/A09. No messages or real money are sent by local acceptance.

## Backup and restore

Set libpq PGHOST, PGPORT, PGUSER, PGDATABASE and a protected PGPASSFILE. Use client
tools compatible with the server (verified here with 18). Keep passwords out of CLI
arguments and history. A database dump contains personal data and credential hashes.
The scripts use mode 0600 files; protect/encrypt off-host storage and restrict access.

```bash
bash deploy/backup.sh /protected/backups/salon-YYYYMMDD-HHMM.dump
```

Schedule backups using the selected host's scheduler, monitor exit status and age,
and copy archive plus checksum off-host. The salon must approve retention, maximum
acceptable data loss (RPO), and recovery time (RTO). A nightly schedule implies up to
one day of data loss; use managed continuous backups/WAL archiving if that is too much.
Dump backups do not include OS secrets, database roles, Caddy configuration or provider
configuration: maintain those separately in protected recovery storage.

Restore into a newly provisioned **empty** recovery database owned by the intended
application role. Set PGDATABASE and RESTORE_TARGET to its name; keep API/workers
stopped and providers disabled throughout the drill:

```bash
bash deploy/restore.sh /protected/backups/salon-YYYYMMDD-HHMM.dump
```

The script checks the supplied archive's hash, refuses populated targets and restores
in one transaction without dropping objects or importing old owners/ACLs. If a
restore fails, inspect the sanitized error, correct the environment and retry into
an empty target. Compare row counts and financial/receipt/commission totals with the
backup's recorded baseline, inspect historical appointments, run migration status,
and start the API against recovery data before considering cutover. Verify all
required privileges using the intended application role.

After real disaster recovery, reconcile payments and provider events that occurred
after the backup. Restored PENDING/PROCESSING notification rows may represent messages
already delivered; consult provider history before enabling delivery. Do not blindly
replay uncertain messages, captures or receipts. Require salon sign-off before switching
DATABASE_URL and opening traffic. Demonstrate this procedure periodically.

## Updates, rollback and daily operation

Take and verify a backup; stage the new release; stop processes if required; migrate;
atomically switch the current symlink; restart all three processes; verify readiness,
login, booking and collections. Retain the previous release. A code rollback only
works if it is compatible with the current schema. Never reverse financial history
or destructively roll back a database merely to roll back code. Use a forward fix or
a separately reconciled recovery/cutover when schema compatibility is lost.

Check service state and sanitized journal events daily. Alert on failed/restarting
processes, readiness failure, expired holds not being cleaned, old PENDING/PROCESSING
notifications, FAILED delivery, required payment reconciliation, backup age/failure,
disk capacity and certificate renewal. Workers intentionally continue after transient
errors; systemd being active alone does not prove delivery or cleanup health.
Use `journalctl -u salon@server -u salon@hold-worker -u salon@notification-worker`.
Never paste raw provider credentials or customer/token data into incident reports.

See OPERATIONS.md for salon workflows and PHASE_11_VERIFICATION.md for actual local
evidence and remaining acceptance. Host service start, certificate issuance, live
provider validation, remote CI and salon sign-off remain release gates.

References: [Caddy SPA/proxy pattern](https://caddyserver.com/docs/caddyfile/patterns),
[PostgreSQL pg_dump](https://www.postgresql.org/docs/18/app-pgdump.html),
[PostgreSQL pg_restore](https://www.postgresql.org/docs/18/app-pgrestore.html).
