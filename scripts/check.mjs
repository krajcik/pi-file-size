import { readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? filesUnder(path) : [path];
    });
}

function run(args) {
  const result = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const sourceDirectories = ["extensions", "src", "test", "scripts"];
const syntaxFiles = sourceDirectories
  .filter((path) => statSync(path).isDirectory())
  .flatMap(filesUnder)
  .filter((path) => path.endsWith(".ts") || path.endsWith(".mjs"))
  .sort();

for (const path of syntaxFiles) run(["--check", path]);
run(["scripts/run-tests.mjs"]);
run(["scripts/validate-package.mjs"]);
