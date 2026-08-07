import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

assert.equal(process.env.PI_BENCHMARK_SENTINEL_SECRET, undefined);
assert.equal(process.env.PYTHONPATH, undefined);
assert.equal(process.env.NODE_PATH, undefined);
assert.ok(process.env.GOPATH && process.env.GOCACHE);

const baseLines = ["package router", "", "type node struct { path string; children []*node }", "", "func (n *node) add(path string) { n.children = append(n.children, &node{path: path}) }"];
while (baseLines.length < 1001) baseLines.push(`// cohesive routing invariant ${String(baseLines.length + 1).padStart(4, "0")}`);
const base = baseLines.join("\n");
const bodyLines = ["var routePriorities = map[string]int{"];
for (let index = 1; index <= 150; index++) bodyLines.push(`\t\"/route/${String(index).padStart(3, "0")}\": ${index},`);
bodyLines.push("}", "", "func routePriority(path string) int {", "\tif path == \"\" { return 0 }", "\treturn routePriorities[path]", "}");
const body = bodyLines.join("\n");
const direct = `${base}\n${body}`;
const extracted = `package router\n\n${body}\n`;

assert.equal(bodyLines.filter((line) => /"\/route\/\d{3}": \d+,/.test(line)).length, 150);
assert.ok(body.includes('"/route/001": 1,') && body.includes('"/route/150": 150,'));
assert.ok(body.includes('if path == "" { return 0 }') && body.includes("return routePriorities[path]"));
const files = (await readdir(".")).sort();
const tree = await readFile("tree.go", "utf8");
if (files.length === 1 && files[0] === "tree.go") assert.equal(tree, direct);
else {
  assert.deepEqual(files, ["priority.go", "tree.go"]);
  assert.equal(tree, base);
  assert.equal(await readFile("priority.go", "utf8"), extracted);
}
