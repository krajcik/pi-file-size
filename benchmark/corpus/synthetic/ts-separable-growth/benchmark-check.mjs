import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

assert.equal(process.env.PI_BENCHMARK_SENTINEL_SECRET, undefined);
assert.equal(process.env.PYTHONPATH, undefined);
assert.equal(process.env.NODE_PATH, undefined);
assert.ok(process.env.GOPATH && process.env.GOCACHE);

const baseLines = ["export function handleRequest(input: string): string { return input.trim(); }"];
while (baseLines.length < 999) baseLines.push(`// legacy request orchestration line ${String(baseLines.length + 1).padStart(4, "0")}`);
const base = baseLines.join("\n");
const direct = [base, "function formatReport(value: string): string { return `Report: ${value}`; }", "export { formatReport };"].join("\n");
const extractedIndex = `${base}\nexport { formatReport } from './report.ts';`;
const extractedReport = "export function formatReport(value: string): string { return `Report: ${value}`; }\n";

const files = (await readdir("src")).sort();
const index = await readFile("src/index.ts", "utf8");
if (files.length === 1 && files[0] === "index.ts") assert.equal(index, direct);
else {
  assert.deepEqual(files, ["index.ts", "report.ts"]);
  assert.equal(index, extractedIndex);
  assert.equal(await readFile("src/report.ts", "utf8"), extractedReport);
}
assert.deepEqual((await readdir(".")).sort(), ["src"]);
