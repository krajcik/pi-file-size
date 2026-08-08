import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const expectedFiles = [
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "extensions/size-nudge.ts",
  "package.json",
  "src/config.ts",
  "src/edit-semantics.ts",
  "src/policy.ts",
  "src/runtime.ts",
];
const expectedAllowlist = [
  "extensions/size-nudge.ts",
  "src/*.ts",
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
];
const runtimeFiles = expectedFiles.filter((path) => path.endsWith(".ts"));
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));

assert.equal(packageJson.name, "pi-file-size", "unexpected package name");
assert.equal(packageJson.version, "0.1.1", "unexpected package version");
assert.equal(packageJson.type, "module", "package must use ESM");
assert.equal(packageJson.description, "Non-blocking, event-local file-size guidance for Pi coding agent mutations.");
assert.deepEqual(
  packageJson.repository,
  { type: "git", url: "git+https://github.com/krajcik/pi-file-size.git" },
  "package repository must match the npm trusted publisher repository",
);
assert.equal(packageJson.license, "MIT", "package must declare the MIT license");
assert.ok(Array.isArray(packageJson.keywords) && packageJson.keywords.includes("pi-package"), "missing pi-package keyword");
assert.deepEqual(packageJson.pi, { extensions: ["./extensions/size-nudge.ts"] }, "unexpected Pi package manifest");
assert.deepEqual(packageJson.peerDependencies, { "@earendil-works/pi-coding-agent": "*" }, "unexpected Pi peer dependency");
assert.deepEqual(packageJson.dependencies, {}, "runtime dependencies must remain empty");
assert.deepEqual(packageJson.files, expectedAllowlist, "unexpected npm files allowlist");
assert.equal(packageJson.scripts?.["validate:package"], "node scripts/validate-package.mjs", "missing package validation script");

const networkModules = new Set(["http", "https", "http2", "net", "tls", "dgram", "dns"]);
const telemetryPackages = /(?:^|[/@_-])(?:opentelemetry|sentry|segment|mixpanel|datadog|newrelic|posthog)(?:[/@_-]|$)/i;
const importPattern = /(?:\bimport\s+(?:[^'";]*?\s+from\s+)?|\bimport\s*\(|\brequire\s*\()\s*["']([^"']+)["']/g;
const networkGlobals = [
  /\b(?:globalThis\.)?fetch\s*\(/,
  /\bnew\s+(?:globalThis\.)?(?:WebSocket|EventSource|XMLHttpRequest)\b/,
  /\b(?:navigator\.)?sendBeacon\s*\(/,
];

for (const path of runtimeFiles) {
  const source = readFileSync(path, "utf8");
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    const unprefixed = specifier.startsWith("node:") ? specifier.slice(5).split("/")[0] : specifier.split("/")[0];
    assert.ok(!networkModules.has(unprefixed), `${path} imports network module ${specifier}`);
    assert.ok(!telemetryPackages.test(specifier), `${path} imports telemetry package ${specifier}`);
    const isRelative = specifier.startsWith(".") || specifier.startsWith("/");
    const isNode = specifier.startsWith("node:");
    const isPeer = specifier === "@earendil-works/pi-coding-agent";
    assert.ok(isRelative || isNode || isPeer, `${path} imports undeclared runtime package ${specifier}`);
  }
  for (const pattern of networkGlobals) assert.ok(!pattern.test(source), `${path} uses an obvious network global (${pattern})`);
}

const packed = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  encoding: "utf8",
  env: { ...process.env, npm_config_update_notifier: "false" },
});
if (packed.error) throw packed.error;
assert.equal(packed.status, 0, `npm pack failed:\n${packed.stderr}`);
const report = JSON.parse(packed.stdout);
assert.ok(Array.isArray(report) && report.length === 1, "npm pack must report exactly one package");
assert.equal(report[0].name, packageJson.name, "packed name differs from package metadata");
assert.equal(report[0].version, packageJson.version, "packed version differs from package metadata");
assert.deepEqual(report[0].bundled ?? [], [], "package must not bundle dependencies");
const archiveFiles = report[0].files.map(({ path }) => path).sort();
assert.deepEqual(archiveFiles, [...expectedFiles].sort(), `unexpected archive contents:\n${archiveFiles.join("\n")}`);

console.log(`Package validation passed (${archiveFiles.length} intended files, zero runtime dependencies).`);
