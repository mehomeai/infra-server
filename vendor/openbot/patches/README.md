# OpenBot patch ledger (pinned MIT source)

Base: `CopilotKit/OpenBot` @ `6bfee780c8e8d05141375ea55ebde33eefb3dbc0`
(hashes in `vendor/openbot/upstream.json`).

Applied patches (deterministic order via `apply.sh`, idempotent):

1. `0001-home-identity-bridge.patch` — Me ht1→BetterAuth exchange (rev 3).
   - New `server/src/home-bridge.ts`: verifies `x-me-home-assertion`
     (HMAC-SHA256, `v2.{userId}.{expMs}.{role}.{nonceHex}.{mac}`, 60s TTL,
     single-use 128-bit nonces via bounded swept cache, role allowlist,
     key `ME_HOME_BRIDGE_SECRET` >= 32 chars, timingSafeEqual).
     Rev3 adds per-request memoization: verified identity cached PER
     ACTUAL REQUEST HEADERS OBJECT (WeakMap) bound to the assertion value,
     so `identifyUser` + `identifyActor` + guards re-reading the SAME
     Request succeed without re-consuming the nonce; a NEW Request / new
     Headers reusing an assertion replays and is refused; mutated headers
     invalidate and refuse (never cookie fallback). Raw
     `verifyHomeAssertion` still denies replay on every call.
   - `server/src/config.ts`: `meHomeBridgeConfigured()` recognises a valid
     dedicated `ME_HOME_BRIDGE_SECRET` (>=32 chars) as an auth authority.
     With a valid key and no external OAuth, full `loadConfig` returns
     `singleUser` false so the bridge-only AuthService boots; missing/short
     keys still fail closed; bridge + `OPENBOT_SINGLE_USER` /
     `OPENBOT_DEV_NO_AUTH` refuses (no shared dev admin); ordinary
     OAuth/org behaviour unchanged when the key is absent.
   - One hunk in `server/src/index.ts`: wraps the assembled `AuthService`
     (`organizationAuth ?? withEntraBearer(...)`) with
     `wrapAuthWithHomeBridge` before `createApp` + `createRequestActor`.
     Covers every guard (`createRequireUser` on all `/api/*`), the
     Copilot `identifyUser`/`identifyActor` seam and the http-server
     websocket guard with a single change. Bridge-only deployments (no
     OAuth app) get a minimal AuthService declining interactive sign-in;
     with no bridge key the bridge path always refuses.
   - `user:{id,email,name,role}` sessions are ephemeral virtual trusted
     principals (no BetterAuth rows created); roles travel per request, so
     operator changes apply on the next call with no restart; unique
     stable home-mapped ids. Tested against the real patched module:
     `test/upstream-patch-live.test.mjs` (same-request re-reads succeed,
     different-request replay refused, expiry/forge refusal, two-family
     isolation, per-request role refresh, bridge-only mode, actual
     `loadConfig` boot with bridge key).
   - Base sha256 at pin: index.ts
     `6d0fa8dc72ae62d7b41f1a35083b1e8e82f53c2fda27255457416075b5d10ddd`,
     config.ts
     `d210a4d4b3c43b869aa38483e5815ac0c3b3f77a6df2d66b5325d7510e3cf3c3`.
     Post sha256 (manifest.json): config.ts
     `03fcdbbf45b1423f8fb1a334c9dcb4c59016701ef3b02266990445c05313ab61`,
     index.ts
     `83a049d5a4adf096e5ddc1f7b4f66388f0b09748f41d9d29a277b42092599701`,
     home-bridge.ts (new)
     `f08df17d508698fbc13d4ce6ef527dfb4296b089da8ab91dcf2e0123d96b1faa`.
     Patch sha256
     `e6575f1013719ebca52816f2f03f8e77d1192aa5532b4db6957cb3a2c6cde871`.
   - No cookie forge (never reads/writes BetterAuth cookies), no shared
     admin (no static user, no `OPENBOT_SINGLE_USER` change, role only from
     signed assertion), no phone `user_id` trust (id inside HMAC only).
   - Inert without `ME_HOME_BRIDGE_SECRET` (pure delegation). Present but
     invalid assertion refuses (never falls through to cookies).

Home side: `src/upstream-identity.mjs` validates Me `ht1_*` sessions
server-side, maps 1:1 to upstream users (`upstream_users` table), roles from
`ME_UPSTREAM_ADMIN_USERS` locally. `src/upstream-proxy.mjs` signs the
assertion per proxied request and strips phone credentials. Upstream
`BetterAuth` + `guards.ts` + `request-actor.ts` policies stay intact.

Machine-readable trust: `manifest.json` carries the exact base commit,
patch sha and original + post sha256 for every modified/new file
(`config.ts`, `index.ts`, `home-bridge.ts`) plus unmodified seam hashes
(`request-actor.ts`, `guards.ts`, `dev-actor.ts`). `apply.sh` verifies the
pin, the patch sha, byte-exact post hashes and unmodified drift, and
refuses on tamper/wrong pin. No temp-only files are production proof.

To add a patch: append `<nn>-<name>.patch` (unified diff, `git apply`
clean at pin), record base hash + review notes here, extend `apply.sh`
order, update `manifest.json` with new post hashes. No silent forks.
`scripts/openbot-checkout.sh` applies this ledger after fetching the pin;
`test/upstream-patch.test.mjs` asserts ledger contents + deterministic
re-application.
