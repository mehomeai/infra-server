# upstream-storage-v1 (for C backup owner)

Private upstream volumes/host data that full backup must include (no Docker
state in git; snapshots via existing upstream helpers; no destructive
migration):

- `postgres-data:/var/lib/postgresql/data` (product rows, audit, policy,
  grants, channels, components; `pgvector/pg17`). Snapshot: `pg_dump` /
  volume copy. Never omit.
- `agent-workspace:/workspace` (per-computer workspaces, per-bot folders;
  task artifacts live here). Snapshot: volume copy / bind export.
- `agent-profiles:/profiles` (`PROFILES_DIR`, Chromium logins per bot).
  Snapshot: volume copy. Reset deletes this (operator danger).
- Bind `./.openbot` (model OAuth dir, `OPENBOT_MODEL_OAUTH_FILE`), `./egress.env`
  (`EGRESS_PROXY_*`), `./.langchain` (`CHATGPT_AUTH_FILE` renewal), SPIRE
  `spire-server-data|agent-data|socket` when SPIRE enabled.
- Licensed self-hosted Intelligence (official chart
  `oci://ghcr.io/copilotkit/charts/intelligence`, overlay
  `deploy/upstream-intelligence-values.yaml`): its own Postgres (>=14,
  threads/memory/entitlement state), Redis (>=7, locks/presence), and the
  AG-UI event bucket when `objectStorage.enabled` (realtime event
  persistence). Snapshot: chart/managed backups per provisioner docs.
  `thread-culler` stays DISABLED (destructive cleanup, not a backup).
- Me home SQLite facade rows stay at home `dbPath` (0600/0700); legacy
  conversations preserved, no erase.

Explicitly NOT implemented: no automatic backup job exists — every snapshot
above is an operator action. Without a configured Intelligence deployment
there are no threads/memory to back up (`NEEDS_INPUT`, never silent loss);
never label a SQLite-only backup as covering Postgres/Intelligence/computer
files.

Machine contract: `results/datastorage-contract.json`.
