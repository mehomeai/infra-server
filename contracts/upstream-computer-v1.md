# upstream-computer-v1 (CORE)

Runtime client contract for the upstream computer plane. Human companion to
`results/computer-contract.json` (machine handoff to Task B) and
`docs/upstream-computer.md`.

- Supervisor: `POST /computers/{person|bot}/<id>/{ensure|stop|reset}`,
  `GET /computers`, `GET /health` (open). Auth
  `Authorization: Bearer <SUPERVISOR_TOKEN>` (timingSafeEqual, not HMAC).
- Identity: `person:<mappedUpstreamUserId>` from validated Me owner,
  server-side 1:1; IDs `^[A-Za-z0-9][A-Za-z0-9_-]*$` ≤64; never raw container
  names; never client `user_id`; never `OPENBOT_SINGLE_USER` on shared/home.
- Gateway: `/api/computers/:botId/...` (browser, files, exec, control,
  secret, fleet/policy admin). Snapshot `{ref,snapshotId}` + run generation;
  `409 stale|humanHasControl|needsConversation`, `503 starting` (retry).
- Transport headers (server-side only): `x-openbot-computer-token`,
  `x-openbot-bot-id`, `x-openbot-person-id`. Tokens never to LLM/phone.
- Opt-out: `DO_NOT_TRACK=1` / `COPILOTKIT_TELEMETRY_DISABLED=1` override;
  `OPENBOT_PRODUCT_TELEMETRY` explicit opt-in only.
- Non-goals: no raw `/api/copilotkit` RunAgentInput calls from runtime; no
  fake `ht1→BetterAuth` exchange (server-side build required); no silent
  fallback to legacy runner (return `NEEDS_SETUP`/unavailable).
