# Readiness handshake — current state and implementation design (OPEN #4)

Status: DESIGN ONLY (no implementation in this document's change).
Scope: infra-server, with setup-infra touchpoints noted. Produced alongside the
OPEN #2 Linux proof (pinned `loadConfig`/`loadTenantPackage` run under Bun —
see the session report; not duplicated here).

Requirement under design: a readiness handshake with

1. 120 s singleflight / TTL / hard invalidation,
2. container-namespace Ollama proof,
3. fleet admin probe + user-role 403.

---

## 1. Current state (measured, file/line at branch `feat/upstream-agent-infrastructure`)

### 1.1 Readiness / health surfaces in the home server (`src/server.mjs`)

- `GET /healthz` (server.mjs:389) — anonymous, synchronous, in-memory. Answers
  `{status:'ok', installation_id, contract, ...capabilityReport(env, liveEvidence())}`.
  Never awaits the network (server.mjs:378-388).
- `GET /readyz` (server.mjs:393-399) — anonymous. 200 `{ready:true}` iff a local
  SQLite meta read succeeds; 503 `not_ready` otherwise. **It checks local
  storage only — it says nothing about upstream/platform readiness.** There is
  no endpoint today that answers "is the full platform ready" from the
  handshake evidence.
- Live tracker wiring (server.mjs:339-349): `createLiveTracker({env,
  fetchImpl: upstreamFetch, intervalMs: liveIntervalMs, ttlMs: liveTtlMs?,
  cachePath: env.ME_DOCTOR_CACHE ?? doctorCachePath(dbPath)})` — one cache file
  shared with CLI/doctor runs (`$ME_DATA_DIR/doctor-cache.json`).

### 1.2 The live-evidence tracker (`src/upstream-live.mjs`) — the existing handshake core

`createLiveTracker` already implements most of the required mechanics:

- **Singleflight**: `refresh()` shares one `inflight` promise across concurrent
  ticks/callers (upstream-live.mjs, `refresh`).
- **Cadence**: default `intervalMs = 120_000` (120 s) via `setInterval`,
  `timer.unref()`, immediate kick on `start()`.
- **TTL**: default `ttlMs = DOCTOR_CACHE_TTL_MS = 300_000` (5 min,
  upstream-doctor.mjs:579). `get()` hard-expires: evidence older than TTL reads
  `{live:false, reason:'stale'}` even if the refresh loop stalls.
- **Hard invalidation (partial)**: a failed probe or config loss flips state to
  not-live **immediately** in `set()` (`probeLiveEvidence` returns
  `reason:'config'` when any of the 14 `REQUIRED_ENV` keys is missing); the
  on-disk cache is only ever written for live verdicts, is atomic (tmp+rename)
  and byte-capped (4096 B), and is re-validated against the same TTL on boot
  seed (`readLiveEvidence`).
- **Probe content** (`probeLiveEvidence`, upstream-live.mjs:62-…): bounded
  (10 s timeout, no redirects), read-only:
  1. upstream `GET /health` must answer `{status:'ok'}`;
  2. upstream `GET /api/capabilities` must include `mode` + `durableHistory`
     (drift check);
  3. authenticated native `GET /api/agents` with a FRESH single-use home
     assertion, role **`user`** only — 401/403 ⇒ `reason:'auth'`; body must be
     an agents array.

**Gaps vs the requirement**: the tracker probe contains **no fleet probe**
(admin or user-403), **no Ollama/model-served proof**, and **no Intelligence
entitlement**. Those exist only in the full doctor (below), which is not on
the 120 s loop. Invalidation triggers are probe-outcome + TTL only — there is
no explicit invalidate signal (config change on disk, patch/manifest drift,
operator request) other than process restart.

### 1.3 The full doctor (`src/upstream-doctor.mjs`, invoked via `src/cli.mjs:115`)

On-demand only (`node … src/cli.mjs upstream-doctor [--no-probe]`). Its probe
set is the superset:

- upstream `/health` `{status:'ok'}` (upstream-doctor.mjs:275-286);
- Postgres TCP liveness + deployed-checkout/pin/manifest verification;
- Intelligence entitlement: `status:'ready' && entitlement.active` plus SDK
  version pin (upstream-doctor.mjs:237-262);
- **Fleet admin probe + user 403 — FULLY IMPLEMENTED here**
  (upstream-doctor.mjs:308-365): fresh single-use assertions signed per probe
  (`signHomeAssertion`, upstream-proxy.mjs:109-128; role ∈ {admin, user}):
  - `GET /api/agents` (user) ⇒ 200 + actor-filtered roster array;
  - `GET /api/computers/fleet` (admin) ⇒ 200 + `{isolation, computers[]}` with
    per-person keys counted (`kind==='person' || personId`);
  - `GET /api/computers/fleet` (user) ⇒ must be exactly **403**; any success
    fails the run ("per-person computer isolation is not enforced");
  - 401 anywhere ⇒ bridge patch/secret misconfiguration.
  Role mapping upstream-side: `src/upstream-identity.mjs:60,84`
  (`INITIAL_ADMIN_EMAILS` ⇒ admin assertion role).
- **Model-served proof** (upstream-doctor.mjs:449-470): for the local route
  (`resolveNativeModelConfig`, runtime-config.mjs:120-147: provider openai +
  `OPENAI_BASE_URL` set + no key), it fetches `${endpoint}/api/tags` and
  requires the selected `BOT_MODEL` tag to be present exactly. Read-only, 8 s
  timeout.
- Verdict is persisted to the shared doctor cache (`writeDoctorCache`,
  upstream-doctor.mjs:~600-640; `readLiveEvidence` accepts only
  `mode:'full' && state:'READY'` payloads within TTL).

**Gap**: none of this runs periodically, and `/readyz` does not consume it.
A stack can pass the doctor at install time and silently rot afterwards; the
phone only learns about it via the lighter tracker, which cannot see fleet
isolation loss or a pulled-model deletion.

### 1.4 Ollama reachability — namespaces

- The doctor's `/api/tags` probe executes in **the doctor process's network
  namespace** (host CLI, or wherever `upstream-doctor` runs). It proves the
  host can reach Ollama at `OPENAI_BASE_URL`.
- The actual consumer is the **agent-harness container**
  (deploy/upstream-full.yml:205-222, env `BOT_MODEL`, `OPENAI_BASE_URL`),
  typically pointed at `http://host.docker.internal:11434/v1`; compose gives
  the **server** service `extra_hosts: host.docker.internal:host-gateway`
  (upstream-full.yml:111-112).
- **Nothing today proves Ollama reachability from inside the harness
  container's namespace.** Host-side success does not imply container-side
  success (missing `extra_hosts` on the harness service, host firewall,
  Ollama bound to 127.0.0.1 only with `OLLAMA_HOST` unset, etc.).
- The legacy in-home runtime path is separate: `resolveModelConfig`
  (runtime-config.mjs:55-73) defaults to `http://127.0.0.1:11434` for
  `HOME_MODEL_PROVIDER=local` — host-loopback, also not a container proof.
- **Blocked in this VM**: no Docker and no Ollama here, so no container-side
  probe can be executed or verified in this environment at all (see §4).

### 1.5 setup-infra touchpoints (read-only survey; nothing edited there)

- `setup-infra/scripts/me_supervisor.py:567-572` — bounded Intelligence
  `/healthz` probe; `:1499`, `:1836` — READY authorisation rules (a bare
  `/healthz` 200 or key presence never authorises READY);
  `:2165-2196` — production gate on the home `/healthz` (status + contract +
  FULL capability fields from the live evidence).
- `setup-infra/scripts/me_setup.py:717-741` — `fetch_healthz` (2 s, one shot)
  and `probe_healthz` (informational); `:1006` — anonymous paths
  `[/healthz, /readyz, /v1/pair]`.
- `setup-infra/scripts/me_lifecycle.py:482-619` — `wait_for_healthz` polling
  during start/restore; `:1548, :2471, :2640-2684` — restored/staged DB
  readiness failures.
- The supervisor consumes the JS doctor's verdict + cache (shared
  `doctor-cache.json`); any handshake change must keep the cache payload
  contract (`mode:'full'`, `state:'READY'`, TTL 300 s) or change both sides
  together.

---

## 2. Design

### 2.1 Principle

Extend the existing tracker rather than building a second system: one
evidence pipeline, two tiers (light loop + full probe), one cache contract,
synchronous reads for consumers. `/readyz` stays storage-only (Kubernetes-style
liveness/readiness split is intentionally NOT collapsed — see §2.4).

### 2.2 Components

1. **`createLiveTracker` v2** (`src/upstream-live.mjs`)
   - Gains a second, FULL probe tier reusing the doctor's probe functions
     (extract the native-auth/fleet/model probe block from
     `src/upstream-doctor.mjs` into a shared module, e.g.
     `src/upstream-probes.mjs`, consumed by both the doctor CLI and the
     tracker; the doctor keeps verdict/schema ownership).
   - Light tier unchanged (120 s). Full tier runs on a slower cadence
     (every 5 light ticks = 10 min) AND on any light-tier state transition
     live→not-live is immediate; not-live→live requires a full-tier pass
     before `live:true` is published (prevents a stack that merely answers
     `/health` from flapping the phone back to "ready").
2. **Container-namespace Ollama proof** (`src/upstream-probes.mjs` + compose)
   - Preferred: a read-only probe endpoint **inside** the harness container:
     the harness already runs the picked AG-UI server; add/depend on its
     model-list call — i.e. the full tier asks the harness itself for its
     served-model view (AG-UI capabilities/models surface) and requires the
     selected tag. This proves the exact path inference takes, from the exact
     namespace.
   - Fallback where the harness exposes nothing: `docker exec`-free design is
     impossible; use the supervisor service (`src/upstream-computer.mjs`
     `health()` precedent, upstream-computer.mjs:131-132) as the in-compose
     witness: full tier fetches Ollama `/api/tags` **via a supervisor-side
     probe route**, i.e. from a container namespace, not the home process.
   - Evidence records which namespace proved it:
     `checks.model.namespace = 'harness' | 'supervisor' | 'host'`, and
     READY requires `'harness'` (or `'supervisor'` during a documented
     transition period), never `'host'` alone.
3. **Fleet/role tier** (already implemented in the doctor; move into the
   shared probe set): admin fleet 200 + shape + per-person keys; user fleet
   exactly 403; user agents 200. Fresh single-use assertion per request,
   exactly as today (upstream-doctor.mjs:308-365 semantics preserved verbatim).
4. **Invalidation bus** (in-process, `createLiveTracker`):
   - `invalidate(reason)` method: drops current evidence to
     `{live:false, reason}` synchronously, cancels nothing in flight but
     **discards an in-flight probe's result if an invalidation landed after
     it started** (generation counter), and kicks an immediate re-probe.
   - Triggers: (a) TTL expiry (exists, in `get()`); (b) any probe failure
     (exists); (c) doctor-cache file mtime/content change observed by the
     tracker (new doctor verdict supersedes tracker evidence — both
     directions); (d) config fingerprint change: hash of the sorted
     `REQUIRED_ENV` values + `BOT_MODEL`/`OPENAI_BASE_URL`, recomputed each
     tick — a changed fingerprint invalidates before probing; (e) an
     authenticated internal call from the CLI (`upstream-doctor` run marks
     the cache; the tracker picks it up via (c)).
5. **Consumer surface** (`src/server.mjs`)
   - `/healthz` unchanged in shape; `capabilityReport` consumes the two-tier
     evidence (additive fields: `evidence: {tier, at, namespace}`).
   - NEW `GET /readyz/full` (anonymous, synchronous, in-memory like
     `/healthz`): 200 iff full-tier evidence is live and within TTL,
     body `{ready, at, checks:{nativeAuth, fleet, model:{selectedServed,
     namespace}, intelligence}}`; 503 otherwise with the failing reason.
     `/readyz` itself is NOT changed (setup-infra lifecycle waits depend on
     its storage-only meaning).

### 2.3 Exact semantics

- **Singleflight**: at most one probe per tier in flight per process;
  concurrent `refresh()` callers share the promise (existing pattern,
  extended per-tier). A full-tier probe and light-tier probe never run
  concurrently (full supersedes: light ticks coalesce into the full run).
- **Windows**: light interval 120 s (unchanged default); full interval
  600 s; probe timeouts unchanged (light 10 s; full per-request 8 s,
  whole-full-run budget 30 s).
- **TTL**: evidence TTL 300 s for light, 900 s for full (full runs every
  600 s, so TTL must exceed the interval; a missed full run ⇒ stale at
  900 s ⇒ not-ready). `get()`-style hard expiry applies per tier: consumers
  never see evidence older than its TTL as live.
- **State machine**: `unknown(boot) → proving → live | not-live(reason)`;
  any invalidation ⇒ `not-live('invalidated:<trigger>')` synchronously,
  before the replacement probe completes. No "last known good" grace for
  fleet-403 or model-not-served failures: those are isolation/correctness
  failures, not transients. (Transient network reasons keep the existing
  behaviour: immediate not-live; the phone already tolerates this.)
- **Cache**: same file, same payload contract (`mode/state/at/ttlMs`),
  extended with `tier` + `generation`; older readers ignore unknown fields
  (verify against setup-infra's parser before landing — see §3 tests).
- **Assertions**: every authenticated probe request signs a FRESH assertion
  (single-use nonce), doctor identity `me-doctor-probe` / tracker identity
  `me-live-probe`; never cached, never logged.

### 2.4 Files a fix would touch

| File | Change |
| --- | --- |
| `src/upstream-live.mjs` | Two-tier tracker, invalidation bus, generation counter, config fingerprint |
| `src/upstream-doctor.mjs` | Extract native-auth/fleet/model probes to shared module; keep verdict + cache ownership. **(Owned by the OPEN #1/#5 workstream — coordinate, do not parallel-edit.)** |
| `src/upstream-probes.mjs` | NEW: shared probe set (health, capabilities, agents, fleet admin/user, model tags, container-namespace variant) |
| `src/server.mjs` | Tracker wiring (intervals), `/readyz/full`, capability report evidence fields |
| `src/upstream-computer.mjs` | Supervisor-witness probe client (if the supervisor route is the namespace witness) |
| `deploy/upstream-full.yml` | Harness/supervisor probe route wiring; `extra_hosts` parity check for the harness service |
| `test/upstream-live.test.mjs` | Two-tier, invalidation, generation, fingerprint tests |
| `test/upstream-config-doctor.test.mjs` | Probe extraction regression (doctor verdicts unchanged) |
| `contracts/` (home-api / upstream-platform) | Document `/readyz/full` + evidence fields + namespace rule |
| setup-infra `scripts/me_supervisor.py` | Only if the cache payload changes incompatibly — design goal is additive-only, so expected: no change; verify with its doctor-schema tests |

### 2.5 Test plan

1. Unit (fake fetch + fake clock, existing test style):
   - singleflight: 5 concurrent `refresh()` ⇒ exactly 1 probe set per tier;
   - TTL: light evidence at t+301 s reads not-live('stale'); full at t+901 s;
   - invalidation during an in-flight probe ⇒ result discarded (generation),
     state stays not-live until the replacement probe passes;
   - config fingerprint change (BOT_MODEL) ⇒ immediate invalidation +
     re-probe; fleet user-200 (isolation break) ⇒ not-live with the fleet
     reason, and NOT recoverable by a light-tier pass alone;
   - model proof: tags missing selected model ⇒ not-live; namespace 'host'
     alone ⇒ not READY.
2. Contract: `/readyz/full` 200/503 shapes; `/healthz` byte-compat for the
   fields setup-infra parses; cache payload round-trip through
   `readLiveEvidence` and through setup-infra's supervisor validation tests.
3. Live (requires Docker + Ollama — **cannot run in this VM**): compose up
   the pinned stack, break Ollama in three ways (stop it; bind 127.0.0.1
   only; remove harness `extra_hosts`) and assert the handshake reports
   not-ready with namespace evidence for the container-side failures while
   the host-side probe alone would have passed the first two.
4. Regression: full home suite (`npm run test:home`), upstream suite
   (`npm run test:upstream`), doctor tests unchanged in verdicts.

### 2.6 Risks

- **Probe extraction churn** in `upstream-doctor.mjs` collides with the
  OPEN #1/#5 workstream editing the same file — sequence after that lands.
- **Assertion burn rate**: full tier every 600 s × 3 signed probes is
  trivial, but replay-protection nonce stores upstream must tolerate the
  cadence (they already tolerate the doctor + 120 s light probe).
- **Flapping**: 300 s light TTL with a 120 s interval leaves ~2 missed
  ticks of headroom; do not shorten TTL without shortening the interval.
- **Namespace witness availability**: if the harness image exposes no
  model surface and the supervisor has no probe route, the container proof
  needs a compose-side addition (sidecar/witness) — that is a deployment
  change, not just code; gate READY on it explicitly rather than silently
  falling back to host proof.
- **Cache contract coupling** with setup-infra: any non-additive change to
  `doctor-cache.json` breaks the supervisor's READY validation across repos;
  treat the payload as a versioned contract.
- **Endpoint composition** for the local route is inherited from
  `resolveNativeModelConfig` (runtime-config.mjs:120-147); the
  container-namespace probe must use the harness's own configured base URL,
  not re-derive one, or the proof can diverge from the inference path.
