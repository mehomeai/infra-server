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
