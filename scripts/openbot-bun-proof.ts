#!/usr/bin/env bun
// Permanent OPEN #2 proof: execute the REAL pinned upstream loaders.
//
// The pinned OpenBot server sources (server/src/config.ts `loadConfig`,
// server/src/tenant-package.ts `loadTenantPackage`) are Bun-runtime-only:
// upstream TypeScript uses extensionless relative imports, which Node
// --experimental-transform-types cannot resolve (ERR_MODULE_NOT_FOUND).
// Node test suites therefore prove the patch SEAM (extracted bytes) but
// can never execute the real loaders. This script is the in-repo proof
// that the real loaders run, under Bun, against a real patched checkout:
//
//   OPENBOT_CHECKOUT=/path/to/openbot bun scripts/openbot-bun-proof.ts
//   npm run test:upstream-bun            (same, via package.json)
//
// Without OPENBOT_CHECKOUT it skips gracefully (exit 0, explicit log) so
// local runs never fail for a missing checkout; CI fetches the pinned
// checkout and runs it for real (.github/workflows/upstream-openbot.yml).
// The tenant package defaults to this repo's deploy/tenant-package/me
// (override with TENANT_PACKAGE_DIR). Checkout dependencies must be
// installed first (`bun install --ignore-scripts` inside the checkout).

import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const checkout = process.env.OPENBOT_CHECKOUT;
if (!checkout) {
  console.log(
    "openbot-bun-proof: SKIP (OPENBOT_CHECKOUT unset) — the pinned " +
      "loadConfig/loadTenantPackage are Bun-runtime-only and need a real " +
      "patched checkout; CI fetches one and runs this proof for real.",
  );
  process.exit(0);
}

const tenantDir =
  process.env.TENANT_PACKAGE_DIR ??
  fileURLToPath(new URL("../deploy/tenant-package/me", import.meta.url));

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`ok - ${name}${detail ? ` (${detail})` : ""}`);
  } else {
    failures++;
    console.error(`FAIL - ${name}${detail ? ` (${detail})` : ""}`);
  }
}
function throws(name: string, fn: () => unknown) {
  try {
    fn();
    check(name, false, "did not throw");
  } catch (e) {
    check(name, true, `throws: ${String((e as Error)?.message ?? e).split("\n")[0]}`);
  }
}
async function throwsAsync(name: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    check(name, false, "did not throw");
  } catch (e) {
    check(name, true, `throws: ${String((e as Error)?.message ?? e).split("\n")[0]}`);
  }
}

const { loadConfig } = await import(
  pathToFileURL(join(checkout, "server/src/config.ts")).href
);
const { loadTenantPackage } = await import(
  pathToFileURL(join(checkout, "server/src/tenant-package.ts")).href
);
check("real pinned modules import under Bun", typeof loadConfig === "function" && typeof loadTenantPackage === "function");

// The Me deployment shape: bridge-only identity (no OAuth provider),
// pinned Intelligence endpoints, synthetic secrets (never real ones).
const baseEnv: Record<string, string> = {
  DATABASE_URL: "postgres://openbot:openbot@127.0.0.1:5432/openbot",
  KEY_ENCRYPTION_KEY: Buffer.from("a".repeat(32)).toString("base64"),
  INTELLIGENCE_API_URL: "https://intel.example",
  INTELLIGENCE_GATEWAY_WS_URL: "wss://intel.example",
  CPK_INTELLIGENCE_API_KEY: "cpk-test-key",
  ME_HOME_BRIDGE_SECRET: "test-bridge-secret-0123456789abcdef-live",
};

// --- loadConfig: bridge-only boot -------------------------------------
const cfg = loadConfig({ ...baseEnv });
check("loadConfig bridge-only: singleUser === false", cfg.singleUser === false, `got ${cfg.singleUser}`);
check("loadConfig bridge-only: port === 3001", cfg.port === 3001, `got ${cfg.port}`);

// --- loadConfig negatives: fail closed ---------------------------------
const { ME_HOME_BRIDGE_SECRET: _drop, ...noBridgeEnv } = baseEnv;
throws("loadConfig no-provider/no-bridge throws", () => loadConfig(noBridgeEnv));
throws("loadConfig bridge + OPENBOT_SINGLE_USER throws", () =>
  loadConfig({ ...baseEnv, OPENBOT_SINGLE_USER: "true" }),
);

// --- loadTenantPackage: this repo's real Me package --------------------
process.env.PICKED_HARNESS_URL = "http://127.0.0.1:4206/";
const pkg = await loadTenantPackage(tenantDir);
check("loadTenantPackage: tenantId === 'me-home'", pkg.tenantId === "me-home", `got ${pkg.tenantId}`);
check(
  "loadTenantPackage: exactly the 'me' agent",
  Array.isArray(pkg.agents) && pkg.agents.length === 1 && pkg.agents[0].id === "me",
  `got ${JSON.stringify(pkg.agents?.map((a: { id: string }) => a.id))}`,
);
check(
  "loadTenantPackage: checksum present",
  typeof pkg.checksum === "string" && pkg.checksum.length > 0,
  `got ${pkg.checksum}`,
);

delete process.env.PICKED_HARNESS_URL;
await throwsAsync("loadTenantPackage without PICKED_HARNESS_URL throws", () =>
  loadTenantPackage(tenantDir),
);

if (failures > 0) {
  console.error(`openbot-bun-proof: ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("openbot-bun-proof: PASS (real pinned loadConfig + loadTenantPackage under Bun)");
