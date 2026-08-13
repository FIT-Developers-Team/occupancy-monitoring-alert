# WIOM Auth, Performance, and UX Implementation Report

Date: 2026-08-13  
Scope: all dashboard routes, authentication, account lifecycle, data refresh, loading/error handling, responsive account UI, production build and security checks.

## Outcome

The app now has exactly two access views:

| Surface | Admin View | SPV View |
|---|---:|---:|
| Operational dashboard, occupancy, heatmap, forecast, density, alerts, integrity, guide | Yes | Yes |
| Alert actions | Yes | Yes |
| Audit trail | Yes | No |
| Settings, sync, thresholds, capacity, escalation | Yes | No |
| Signup gate, approval, account and role management | Yes | No |

Direct requests to Admin-only pages are redirected by the request proxy. Admin APIs also perform their own role check, so hiding navigation is not the security boundary.

## Authentication and account lifecycle

### Signup

1. Signup is closed by default.
2. Admin opens it from **Settings → Accounts & access**.
3. The login screen then exposes **Register as SPV**.
4. A submission requires full name, username, `@astronauts.id` email, password, and confirmation.
5. Passwords are limited to 5–128 characters, as requested.
6. The account remains `pending` and cannot sign in.
7. Admin approves or rejects it.
8. Approval activates SPV View immediately.

Rejected usernames can submit a corrected registration when signup is opened again. Duplicate active/pending usernames and work emails are rejected.

### Admin bypass

Admin can create an active Admin or SPV account directly. Admin can also change the view role, disable/reactivate an account, or set a new password. The last active Admin cannot be disabled or demoted, and an Admin cannot disable their own account.

### Forgot password

Forgot password is intentionally Admin-assisted rather than an unauthenticated self-reset:

1. SPV submits username and work email.
2. The public response is identical whether the account exists or not, preventing account enumeration.
3. A matching request appears in the Admin account panel.
4. Admin sets a temporary password and shares it through an internal trusted channel.
5. All older sessions are invalidated immediately.

Legacy bootstrap accounts did not store an email. They can still raise a reset request with an `@astronauts.id` contact; Admin must verify that contact internally before sharing the temporary password.

### Security controls

- Passwords use scrypt with a unique random salt; plaintext is never persisted or audited.
- Session cookies are HMAC-signed, HTTP-only, SameSite=Lax, 12-hour sessions, and Secure in production.
- Session versioning invalidates active cookies after password, role, approval, rejection, or status changes.
- Login, signup, and reset endpoints have bounded in-memory rate limits.
- Account and signup-gate mutations are audit logged without password hashes.
- Account writes are atomic and stored on the existing persistent `db` volume.
- Readiness now requires at least one active Admin account.

The account store is designed for the current single-web-replica, low-cost deployment. Before running multiple web replicas that can mutate accounts concurrently, move the account store to a shared transactional database.

## Loading and data freshness

### Root cause

Dashboard pages execute large DuckDB aggregate scans. Calls issued with `Promise.all` still pass through a deliberate global query queue because concurrent native DuckDB reads previously destabilised the process and consumed too much VPS memory. A cold route therefore waited for several aggregates serially. The previous blocking popup made that delay more disruptive and gateway timeouts could fall through to the route error boundary.

### Implemented read model

Expensive, read-only aggregates now use a persistent stale-while-revalidate cache under `db/read-model-cache/`:

- warehouse base summary;
- warehouse trend;
- zone summary;
- occupancy scope quality;
- integrity summary;
- forecast rows;
- dense/prioritised SLOC list.

Rules:

- The first ever request waits for real DuckDB data; no synthetic figures are generated.
- A valid previous result is returned immediately while a changed Superset snapshot is recomputed.
- Cache versions include the history database version and occupancy policy configuration.
- Configuration changes clear in-memory entries and cause a background refresh.
- Cache files contain operational aggregates only, not credentials or account data.
- The topbar explicitly reports **Data synced**, **Sync in progress**, or **Last valid data**, so a fast fallback is never presented as a confirmed new sync.

The full-page loading popup was removed. Route transitions only show a delayed slim progress bar and keep the existing shell readable. Unexpected errors no longer expose raw server error text.

## Runtime measurements

Measurements were taken locally against the current real DuckDB snapshot, after route compilation, using authenticated HTTP requests.

| Route | First request after implementation | Warm/persistent read model | Previous baseline in this run |
|---|---:|---:|---:|
| Overview | 4.019 s | 0.319 s | 13.115 s |
| Occupancy | 2.733 s | 0.806 s | 8.681 s |
| Forecast | 1.814 s | 0.389 s | 8.348 s |
| Priority locations | 4.187 s | 2.122 s | 9.362 s |
| Audit | 1.466 s | 0.970 s | 6.818 s |

Audit HTML decreased from approximately 1.1 MB to 266 KB by selecting and bounding preview fields instead of embedding complete configuration JSON in every row. The audit database still retains the complete original records.

Results are machine- and snapshot-specific; production latency also depends on VPS CPU, disk and reverse-proxy timeouts.

## UI/UX decisions

- Login, signup and forgot-password share one focused authentication panel.
- Every password field includes an explicit Show/Hide control with an accessible label.
- Signup only appears while the Admin gate is open.
- Account management is the first Admin Settings tab and groups gate status, pending approvals, reset requests and account creation.
- Pending, active, rejected and disabled states have consistent badges and actions.
- Desktop rows collapse to mobile cards; creation/reset dialogs become bottom sheets on small screens.
- Inputs reuse the existing FIT design tokens, button styles, typography, spacing and status colours.
- Admin-only navigation is removed from both the sidebar and command palette in SPV View.

Visual screenshot auditing could not be completed in this run because the Codex in-app browser controller was unavailable. Runtime HTML, responsive CSS, API behaviour and production builds were verified, but screenshot-based visual comparison and keyboard/screen-reader testing remain separate acceptance work.

## Validation completed

- Production `next build`: passed.
- TypeScript `tsc --noEmit`: passed.
- `npm audit --omit=dev`: 0 vulnerabilities.
- Transitive `nanoid`: upgraded from vulnerable 3.3.16 to 3.3.18.
- Docker Compose config: valid.
- Supervisor and helper Node syntax: valid.
- `git diff --check`: passed.
- Production smoke: login, secure cookie, account readiness, Admin API, data-status API and dashboard HTTP 200.
- Auth lifecycle: signup gate, pending, approve, login, reset request, Admin reset, old-session invalidation, disable and SPV Admin-route blocking all passed.

Local production readiness returned `503` only when the Superset worker was deliberately disabled for the isolated smoke test. Authentication, account storage and dashboard storage checks were ready; deployment readiness still correctly requires the configured sync worker to be healthy.
