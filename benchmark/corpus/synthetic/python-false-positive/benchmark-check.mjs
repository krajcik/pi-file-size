import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

assert.equal(process.env.PI_BENCHMARK_SENTINEL_SECRET, undefined);
assert.equal(process.env.PYTHONPATH, undefined);
assert.equal(process.env.NODE_PATH, undefined);
assert.ok(process.env.GOPATH && process.env.GOCACHE);

const baseLines = ["COMMANDS = {", "    \"alpha\": \"Create an item\","];
while (baseLines.length < 999) baseLines.push(`    \"command_${String(baseLines.length).padStart(4, "0")}\": \"Stable command\",`);
baseLines.push("}");
const expected = [...baseLines];
expected.splice(-1, 0, "    \"tau\": \"Inspect an item\",");

assert.deepEqual((await readdir(".")).sort(), ["registry.py"]);
assert.equal(await readFile("registry.py", "utf8"), expected.join("\n"));
