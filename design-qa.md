# Design QA

## Visual truth

- User reference:
  `C:\Users\Aditya Fauzi\Pictures\Screenshots\Screenshot 2026-07-22 121409.png`
- Earlier broken implementation:
  `C:\Users\ADITYA~1\AppData\Local\Temp\codex-clipboard-cfd95b87-a651-4f23-aa92-5856515d5247.png`
- Final desktop Overview:
  `audit\overview-desktop-final.png`
- Final desktop Heatmap:
  `audit\heatmap-desktop-final.png`
- Final 390×844 Heatmap:
  `audit\heatmap-mobile-final.png`
- Stale-bundle diagnostic:
  `audit\heatmap-stale-bundle.png`

The final production preview runs at `http://localhost:3101`.

## Verified

- A clean production build completes, including TypeScript and all 19 generated
  page entries.
- `npm run build` now removes only the workspace `.next` directory before
  building. This prevents the stale Tailwind/Next cache from serving old CSS
  after source changes.
- The final CSS bundle contains the shared dashboard, metric, occupancy, and
  heatmap selectors plus the corrected responsive KPI rules.
- Authenticated production smoke checks pass for all 12 dashboard routes and
  six key APIs (18/18 checks).
- The smoke pass checks expected English (UK) page headings on the initial
  server render. Client components receive the server-selected language, so
  there is no ID→EN flash.
- Desktop Overview at 1280×720 has no blank KPI cell. Seven metrics use a
  filled 4+3 layout at this width.
- The desktop Heatmap was compared directly with the supplied reference.
  It uses compact zone cards and portrait 6×6 SLOC matrices rather than the
  reference's landscape rows.
- Heatmap cell detail and the paged full-zone dialog both open and load real
  SLOC/SKU data.
- The 390×844 Heatmap uses one card per row, a wrapped two-line legend, and has
  no document-level horizontal overflow (`scrollWidth = viewport = 380`).
- Heatmap summary, exact-SLOC lookup, command search, forecast, alerts, and data
  integrity endpoints return valid JSON.
- Priority Locations is ranked and limited inside DuckDB; its production page
  request completed below one second in the latest warm pass.
- The warehouse allowlist remains exactly the requested eight operational
  `location_id` values: 160, 661, 772, 796, 819, 860, 912, and 983.

## Operational caveat

At the final audit, `/api/health` returned `degraded` only because the latest
Superset snapshot was about 149 minutes old. History DB, configuration, and
state DB checks were all healthy. The data-sync loop must be running for the
30-minute freshness check to return `ok`.

## Status

Code, clean build, login, route/API smoke, desktop visual QA, and mobile visual
QA: passed.

Live Superset snapshot freshness: pending restart or recovery of the external
sync process.
