import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runBenchmark } from "./harness.mjs";

const requestedOutput = process.argv[2];
const output = requestedOutput
  ? resolve(requestedOutput)
  : join(await mkdtemp(join(tmpdir(), "pi-file-size-smoke-")), "pairwise-report.json");

try {
  const result = await runBenchmark(fileURLToPath(new URL("./smoke.config.json", import.meta.url)), { output });
  process.stdout.write(`${JSON.stringify(result.report)}\n`);
  console.error(`Smoke report: ${result.output}`);
} catch (error) {
  if (error.report) process.stdout.write(`${JSON.stringify(error.report)}\n`);
  console.error(error.message);
  process.exitCode = 1;
}
