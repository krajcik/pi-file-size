import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

assert.equal(process.env.PI_BENCHMARK_SENTINEL_SECRET, undefined);
assert.equal(process.env.PYTHONPATH, undefined);
assert.equal(process.env.NODE_PATH, undefined);
assert.ok(process.env.GOPATH && process.env.GOCACHE);

const lines = ["export interface PackageJson {", "  name?: string;"];
while (lines.length < 1099) lines.push(`  field${String(lines.length).padStart(4, "0")}?: string;`);
lines.push("  benchmarkField?: string;", "}");

assert.deepEqual((await readdir(".")).sort(), ["package-json.d.ts"]);
const source = await readFile("package-json.d.ts", "utf8");
assert.equal(source, lines.join("\n"));
assert.doesNotMatch(source, /benchmarkField:\s*string/);
