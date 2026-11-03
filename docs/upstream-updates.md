# Keeping upstream improvements flowing

## Imported subset and ownership

The source pin and SHA-256 inventory live in `vendor/openmuse/upstream.json`.
Only the worker, logging helper, and license are imported. Do not edit those files
in place. Put Me adapters and integration tests outside the vendor directory.
If a necessary upstream patch arises, first try an adapter or an upstream fix;
otherwise record a reproducible patch separately before changing this zero-patch
update policy.

This mechanism refreshes existing imported files; it does not magically adopt
new capabilities, dependencies, screens, or source paths. The update PR links to
the full upstream commit comparison so reviewers can identify useful new work.
New imports require an explicit allowlist/license/test change.

## Automation included

Normal CI verifies source hashes and runs the Python updater tests, real-worker
integration tests, and model-free demo. The scheduled workflow runs Mondays at
09:17 UTC and supports manual dispatch with an optional full upstream SHA.

Its first job has read-only repository permissions and no model, household,
deployment, or publishing credentials. It resolves upstream `main`, downloads a
fixed file list at that immutable commit, and runs the compatibility suite. Only
a passing candidate produces an artifact bundle. A failing candidate stops the
workflow and does not open an update PR.

A separate job, on a fresh runner, uses the approved updater to validate that
bundle's paths, hashes, revision and contents. It does not execute the candidate
code. It commits only `vendor/openmuse` to a revision-specific branch and opens a
review PR. There is no automatic merge, deployment, or home update.

GitHub Actions dependencies retain the existing weekly Dependabot configuration. Pins
are exact commits; action upgrades arrive for review independently of OpenMuse.

## Activation and GitHub behavior

These workflows must first be committed/pushed and merged to the repository's
default branch. No workflow was remotely enabled, dispatched, or published by
this local implementation.

The repository/organization must permit GitHub Actions to create pull requests.
The proposal job explicitly requests contents/PR write permissions. If policy
forbids PR creation, the candidate test job can still run and retain its bundle;
the proposal job will fail visibly rather than pretending the PR was opened.

PRs created with `GITHUB_TOKEN` normally do not trigger ordinary push/PR workflow
runs. Candidate checks already execute before proposal; maintainers should
manually dispatch `CI` on the proposal branch if independent branch checks are
required. A narrowly scoped GitHub App is a later option for automatic PR-check
triggering; no personal token is required or requested by this prototype.

Review license changes, new imports/dependencies, task-state semantics, side
effects, resource behavior, and data access before merging. A source-compatible
worker is only one part of overall product compatibility.

## Local operation

```sh
# Offline verification and regression checks
python3 scripts/upstream.py verify
python3 -m unittest discover -s scripts -p 'test_*.py' -v
npm run test:spike

# Network required: inspect latest main without changing source
python3 scripts/upstream.py check

# Network required: update the fixed subset to a reviewed full commit SHA
python3 scripts/upstream.py update --revision FULL_40_CHARACTER_COMMIT_SHA
```

An update refuses to overwrite drifted vendor source. Downloads finish before
the source snapshot is changed. An interrupted filesystem write can leave a
failed checksum; recover the reviewed snapshot from Git rather than continuing
with a partially changed tree. This is a development updater, not a household
release installer or transactional database migration tool.

## Product release integration

Upstream integration and household deployment are separate stages:

```text
upstream commit -> candidate tests -> review PR -> reviewed integration
-> phone/backend/home/installer contract tests -> signed/versioned release
-> staged household update with compatible migrations and recovery
```

Only the source-candidate stages are implemented here. The product release
manifest, signed distribution, full cross-repo tests, installer rollout, and
data-compatible rollback remain work for the integrated product milestone.
