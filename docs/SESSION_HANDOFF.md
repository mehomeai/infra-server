# Session Handoff — infra-server (2026-11-03)

> WIP draft on `feat/upstream-agent-infrastructure`. NOT main / production-ready. Implementation paused for machine move; migration NOT complete. Parent owns all Git.

- Central handoff: `../.github/docs/agent-infrastructure-handoff-2026-11-03.md`
- Machine-readable: `../.github/docs/agent-infrastructure-checkpoint/agent-infrastructure-checkpoint-2026-11-03.json`
- This repo branch: `feat/upstream-agent-infrastructure` (WIP draft)
- PR: pending publication (parent adds link; never guess).
- Reported: home 181 pass / 1 pre-existing R2 skip, upstream 78, Python 17; native transport 25/25 vs REST fixture; auth patch 15/15 (F-owned `manifest.json`, patch `e6575f10…`).
- Needs review: F manifest filename mismatch (`patch-manifest.json` vs `manifest.json`); ALL post-hash + drift fail-closed; pinned `loadConfig`/`loadTenantPackage` on Linux; readiness singleflight/TTL; fleet per-person + user 403; strict doctor schema.
- Resume: central restore snippet → inspect partial installer key-mapping/tests → narrow OpenCode fixes → Linux acceptance. Mandate: `opencode run` default model only.
