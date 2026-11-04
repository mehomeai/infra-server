# infra-server

Infrastructure services for the Me Home AI platform.

Part of [Me Home AI](https://github.com/mehomeai), a privacy-first home agentic system.
Learn about the vision at [Me — Your intelligence. Yours.](https://mehomeai.replit.app/me/).

## Status

Implemented on `main`: the home-agent foundation merged via PR #1,
and the upstream agent infrastructure (pinned OpenBot reuse) merged
2026-11-03 via PR #3. No deployed release. Home service
(single-host SQLite + task workers): pairing, sessions, conversations,
tasks, durable questions/approvals, parallel children (R8 `task-rpc-v1`),
notifications outbox (opt-in, generic payloads only), coordinator heartbeat
(H8, `homeToken` `0600`, cloud-offline never blocks private API), and
backup/restore against the real `runtime-bridge-v1` subprocess worker.
Household data and execution stay on the home host; local Ollama default —
an explicitly opted-in remote provider then receives the scoped
prompt/history/tool context. No private chat relay/storage at cloud.
Live-model checks use synthetic data only, never household data. The
original model-free reuse spike is kept under `spikes/` and still verified.
This is not a provisioned tunnel endpoint, IdP, native push delivery, or
production install — see the manual gates below and overall evidence in
`backend-server/docs/final-validation.md`. Verified (finals): **103 pass +
1 skip** home independent full; **9 pass** actual home + actual runtime
runners (serial).

## Scope

Infrastructure provisioning, service operation, observability, and recovery.

The service runs on the user's separate home computer and hosts private household
data and agent execution. Me's hosted application backend lives in
`backend-server`. See [the reuse spike](docs/reuse-spike.md) for exact boundaries,
checks, and the next integration gates.

The [home connection and phone pairing flow](docs/connection-and-pairing.md)
covers the named-tunnel endpoint, one-time local `home-pairing-v1`
enrollment, per-device revocable credentials, and the hosted backend's
coordination-only role. Phones use the direct paired HTTPS home URL;
the cloud `endpointHint` is discovery only and never moves credentials
(`PAIRING_REQUIRED` on change). The tunnel connector credential itself is
provisioned out-of-band by the operator; setup records the reference only.

## Run the home service

Authoritative operator runbook:
[docs/end-to-end-runbook.md](docs/end-to-end-runbook.md) (§0 prerequisites,
§1 start/health, §2 fixture demo, §3 pairing, §4 task lifecycle, §6 exact
per-repo verification commands). Do not duplicate its commands here.

```sh
node --version            # v24.18.x required
npm run test:home         # H1/H2/H3/H4 + R2-gated tests (needs sibling runtime checkout for R2)
npm run test:spike        # pinned worker reuse (model-free)
python3 scripts/upstream.py verify
python3 -m unittest discover -s scripts -p 'test_*.py' -v
```

Manual gates (never automatic): a live model backend (Ollama locally, or an
explicitly opted-in remote endpoint + key), Docker images for `run_code`,
and the provisioned protected tunnel for anything beyond loopback.
Absent backends fail honestly (`model_not_configured` /
`prerequisite_missing`); the fixture demo proves the subprocess/task path
only, never model quality.

## Run the reuse spike

Use Node.js 24.18.x and Python 3. No npm dependencies or model credentials are
needed; no installation command is required.

```sh
python3 scripts/upstream.py verify
python3 -m unittest discover -s scripts -p 'test_*.py' -v
npm run test:spike
npm run demo:spike
```

The demo uses synthetic owners/conversations and a temporary local database,
then removes its data. It makes no model or external-service calls.

## Upstream integration

Imported source stays unchanged under `vendor/openmuse` with its MIT license,
commit pin, and SHA-256 inventory. Local adapters stay outside that directory.
See [third-party notices](THIRD_PARTY_NOTICES.md) and
[update operation](docs/upstream-updates.md).

After these changes are merged into the repository's default branch, the weekly
workflow can test newer upstream source and propose a review PR. It does not
automatically merge changes or update home installations.

## Contributing

Start with the [contribution guide](https://github.com/mehomeai/.github/blob/main/CONTRIBUTING.md),
[code of conduct](https://github.com/mehomeai/.github/blob/main/CODE_OF_CONDUCT.md), and
[governance](https://github.com/mehomeai/.github/blob/main/GOVERNANCE.md).
Discuss substantial changes in an issue before implementing them. Pull requests
should include relevant tests and documentation once application code exists.

For questions and cross-project planning, use [community discussions](https://github.com/mehomeai/.github/discussions).
Report vulnerabilities privately through this repository's **Security → Report a vulnerability**;
see the [security policy](https://github.com/mehomeai/.github/blob/main/SECURITY.md).

## License

[Apache License 2.0](LICENSE). Third-party code, model weights, and datasets may
have their own terms and must be reviewed before inclusion.
