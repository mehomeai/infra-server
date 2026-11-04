# Session Handoff — infra-server (2026-11-03)

> WIP draft on `feat/upstream-agent-infrastructure`. NOT main / production-ready. Original migration paused; only publication handoff complete. Parent owns all Git. Do not fix code now.

- Central handoff: https://github.com/mehomeai/.github/blob/feat/upstream-agent-infrastructure/docs/agent-infrastructure-handoff-2026-11-03.md (note: `../.github` is wrong from `docs/`; restore clones `.github` as `me-github`)
- Machine-readable: https://github.com/mehomeai/.github/blob/feat/upstream-agent-infrastructure/docs/agent-infrastructure-checkpoint/agent-infrastructure-checkpoint-2026-11-03.json
- Immutable snapshot (preserve): https://github.com/mehomeai/.github/blob/feat/upstream-agent-infrastructure/docs/agent-infrastructure-checkpoint/git-snapshot.json
- This repo branch: `feat/upstream-agent-infrastructure` (WIP draft)
- PR: https://github.com/mehomeai/infra-server/pull/3
- Reported: home 181 pass / 0 fail / 1 pre-existing R2 skip, upstream 78, Python 17; native transport 25/25 vs REST fixture; auth patch 15/15 (F-owned `manifest.json`, patch `e6575f10…`).
- Resume blocker (setup-infra, Diff-N): actual `python3 -m unittest discover -s scripts -p "test_me*.py"` ran 166, FAILED 3 (`test_imported_dependency_tamper_fails_closure`, `test_generic_key_satisfies_native_check`, `test_operational_ready_reachable_without_backup_claims`); source preserved unfinished, suite NOT passing.
- Needs review: F manifest filename mismatch (`patch-manifest.json` vs `manifest.json`); ALL post-hash + drift fail-closed; pinned `loadConfig`/`loadTenantPackage` on Linux; readiness singleflight/TTL; fleet per-person + user 403; strict doctor schema.
- Parent all-8 repository-health checks pass. Final post-push CI pending / not awaited.
- Resume: central restore snippet → inspect partial installer key-mapping/tests → narrow OpenCode fixes → Linux acceptance. Mandate: `opencode run` default model only.
