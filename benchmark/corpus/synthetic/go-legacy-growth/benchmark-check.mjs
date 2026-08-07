import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

assert.equal(process.env.PI_BENCHMARK_SENTINEL_SECRET, undefined);
assert.equal(process.env.PYTHONPATH, undefined);
assert.equal(process.env.NODE_PATH, undefined);
assert.ok(process.env.GOPATH && process.env.GOCACHE);

const baseLines = ["package legacy", "", "type Server struct{}", "", "func (Server) Health() string { return \"ok\" }"];
while (baseLines.length < 1050) baseLines.push(`// stable legacy handler line ${String(baseLines.length + 1).padStart(4, "0")}`);
const base = baseLines.join("\n");
const bodyLines = ["var auditRules = map[string]bool{"];
for (let index = 1; index <= 150; index++) bodyLines.push(`\t\"rule-${String(index).padStart(3, "0")}\": true,`);
bodyLines.push("}", "", "func (Server) Audit() string { return \"audit\" }");
const body = bodyLines.join("\n");
const direct = `${base}\n${body}`;
const extracted = `package legacy\n\n${body}\n`;

assert.equal(bodyLines.filter((line) => /"rule-\d{3}": true,/.test(line)).length, 150);
const files = (await readdir(".")).sort();
const server = await readFile("server.go", "utf8");
if (files.length === 1 && files[0] === "server.go") assert.equal(server, direct);
else {
  assert.deepEqual(files, ["audit.go", "server.go"]);
  assert.equal(server, base);
  assert.equal(await readFile("audit.go", "utf8"), extracted);
}
