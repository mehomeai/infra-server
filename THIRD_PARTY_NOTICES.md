# Third-party source

`vendor/openmuse` contains an unmodified subset of
[CopilotKit/openmuse](https://github.com/CopilotKit/openmuse), pinned in
`vendor/openmuse/upstream.json`. Its MIT license and copyright notice are retained
in `vendor/openmuse/LICENSE`. These files retain their upstream license; Me's root
Apache-2.0 license does not replace it.

Imported files: `apps/server/src/engine/worker.ts`, `apps/server/src/log.ts`, and
`LICENSE`. Local adapters/tests live outside the vendor directory. No upstream
patches are applied. The worker's type-only imports are erased by Node's
TypeScript transformation; this spike does not import the full upstream
application or its dependencies. It is not a substitute for upstream's complete
typecheck/build/test suite.

Checksums detect local drift and identify reviewed source; they do not establish
upstream authorship or prove source is safe. Updates run compatibility tests and
are proposed for review. They are not automatically merged or installed on homes.

`vendor/openbot` is a lock only (no vendored copy): an immutable subset of
[CopilotKit/OpenBot](https://github.com/CopilotKit/OpenBot), pinned in
`vendor/openbot/upstream.json` at `6bfee780c8e8d05141375ea55ebde33eefb3dbc0`
(MIT). Deployment uses a full pinned `git clone --sparse` checkout executing
actual upstream `agent-computer`/`supervisor` Dockerfiles/services
(`scripts/openbot-checkout.sh`, `deploy/upstream-core.yml`); no rewritten
engine, no in-repo huge assets. Verified by
`python3 scripts/upstream-openbot.py verify [--fetch|--deployed DIR]`. One
reviewed patch is applied at deploy time, never vendored:
`vendor/openbot/patches/0001-home-identity-bridge.patch` rev 2 (Me ht1→BetterAuth
single-use assertion seam, bridge-only mode; deterministic `apply.sh`; ledger
in `patches/README.md`; exercised against the real patched module in
`test/upstream-patch-live.test.mjs`).
See `docs/upstream-computer.md` and `docs/upstream-deployment.md`.
