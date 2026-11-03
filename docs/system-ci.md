# System CI

Offline CI is per-repo and loopback-only. Cross-repo acceptance is manual
with pinned SHAs. Root-level QA is in progress; no release counts claimed here.

## Offline commands (exact)

From each repo root:

```sh
# agentic-framework
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/pip install --no-deps -e .
.venv/bin/python -m pytest tests --ignore=tests/test_live_optin.py -v
# pin coherence (CI): Dockerfile tag tracks pyproject + pip pin, 1.64.1

# infra-server (standalone; backend-absent safe)
node --experimental-transform-types --disable-warning=ExperimentalWarning --test test/home-api.test.mjs test/home-h5.test.mjs test/home-h6.test.mjs test/home-notifications.test.mjs test/home-notifications-h71.test.mjs test/home-tasks.test.mjs test/home-r2.test.mjs
npm run test:spike
python3 scripts/upstream.py verify
python3 -m unittest discover -s scripts -p 'test_*.py' -v

# backend-server
npm ci --no-audit --no-fund
npm test

# phone-app (portable, always)
npm test
# real-services is manual only (see below); portable B4 uses a stub shape
# with a diagnostic when the backend sibling is absent, never a silent pass.

# phone-app/apps/mobile (full checks need installs; parked for disk)
node scripts/check-mobile-syntax.cjs   # syntax-only, needs typescript compiler
cd apps/mobile && npm run typecheck    # full tsc --noEmit, needs npm install
cd apps/mobile && npm run test:ui      # expo export + Playwright, needs Chromium

# setup-infra (all offline suites)
python3 -m unittest discover -s scripts -p 'test_me*.py' -v
```

Portable `npm test` in `phone-app` is zero-dependency and has no sibling,
device, or tunnel requirement. Full mobile `typecheck` / `test:ui` need
`apps/mobile` installs plus a Chromium binary and are not stubbed; the SDK
declarations (`expo ~58`, `@playwright/test ^1.64.1`) are declared-only until
installed. Native bundle/device behavior is verified on hardware only.

Browser image coherence: `docker/browser/Dockerfile`
(`mcr.microsoft.com/playwright/python:v1.64.1-noble`) tracks the pinned SDK
(`playwright==1.64.1` in `pyproject.toml` browser extra and the Dockerfile
pip line); mobile `@playwright/test ^1.64.1` stays on the same major. The
agentic `pin-coherence` CI job fails closed on drift with no pulls or installs.
Docker build/pull is operator-only via the existing Dockerfile; CI never
pulls and no local Docker proof is claimed.

## Manual system acceptance

Workflow: `infra-server/.github/workflows/system-acceptance.yml`
(`workflow_dispatch` only, `contents: read`).

Inputs (all required, full 40-char hex): `backend_ref`, `phone_ref`,
`setup_ref`, `runtime_ref`. Home uses the current `github.sha`. SHAs are
validated before any checkout; checkouts use `persist-credentials: false`
with no reusable credentials, provider keys, or tunnels.

It checks out the actual sibling layout under `siblings/`
(`infra-server`, `backend-server`, `phone-app`, `setup-infra`,
`agentic-framework`), installs backend `npm ci` and the exact runtime
`requirements.txt` + editable package in `agentic-framework/.venv`, then runs
the real suites with fail-closed gating (`ME_HOME_REQUIRE_R2=1`,
`ME_RUNTIME_REQUIRE_HOME=1`; missing files fail, never skip-green):

- home full (`npm run test:home` incl. coordinator + R2), spike, upstream verify
- backend full (`npm test`)
- phone portable (`npm test`) + real (`npm run test:real` with pinned `ME_REAL_*_SRC`)
- runtime regression (pytest, no live) + all home runners (delegation + context, actual home bridge; files run serially via `--test-concurrency=1` since each boots real runtime children)
- setup all (`test_me*.py`)

No live model calls or Docker pulls by default. Remote dispatch requires all
five SHAs to be committed and pushed; the same suites can also run locally
against the current working trees placed side by side as siblings.
Dispatch the workflow only after all five SHAs exist on the server.

Upstream: the OpenMuse fixed-path updater + review-PR flow in
`upstream-openmuse.yml` is preserved as-is (candidate runs read-only,
untrusted code never runs in the write-token job). New upstream UI, tools, and
features need explicit adoption and their own acceptance; they are not automatic.

## Known scope and hardware gates (manual, never automatic)

- Loopback only; no provisioned tunnel, hosted relay, or public endpoint.
- Live model backend (local Ollama or explicit remote endpoint + key) is a
  manual gate; fixture runs prove the subprocess path only.
- `run_code` Docker image and `browser_open` isolated image are pre-provisioned
  by the operator; absent images fail closed (`prerequisite_missing`).
- Physical phone checks: pairing, chat persistence, airplane-mode queueing,
  task approvals with masked previews, artifact save/share scoping, push
  lifecycle with a fake provider only on a real device, and the redirect
  `error`-mode native verification in `apps/mobile/TESTING.md`.
- Coordinator (`home-coordinator.test.mjs`) self-skips honestly when the backend
  sibling is absent; system acceptance runs it with siblings present and
  `npm run test:home` covers it there. Home unit stays green either way.
- R2 (`home-r2.test.mjs`) uses a sibling-relative runtime checkout and
  self-skips without it; `ME_HOME_REQUIRE_R2=1` enforces the actual bridge.
