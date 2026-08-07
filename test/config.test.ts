import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { CONFIG_FILENAME, INVALID_CONFIG_WARNING, loadSessionPolicy } from "../src/config.ts";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "size-nudge-config-"));
  temporaryRoots.push(root);
  return root;
}

after(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

test("valid trusted project config supports only the four policy fields", async () => {
  const root = await temporaryRoot();
  await mkdir(join(root, ".pi"));
  await writeFile(join(root, ".pi", CONFIG_FILENAME), JSON.stringify({
    maxLines: 12,
    significantGrowthLines: 4,
    include: ["vendor/**", "/external/generated/**"],
    exclude: ["dist/**"],
  }));
  const warnings: string[] = [];
  const policy = await loadSessionPolicy(root, true, (message) => warnings.push(message));
  assert.deepEqual(policy, {
    maxLines: 12,
    significantGrowthLines: 4,
    include: ["vendor/**", "/external/generated/**"],
    exclude: ["dist/**"],
    projectRoot: root,
  });
  assert.deepEqual(warnings, []);
});

test("missing or untrusted config uses defaults without warning", async () => {
  const root = await temporaryRoot();
  const warnings: string[] = [];
  assert.equal((await loadSessionPolicy(root, true, (message) => warnings.push(message))).maxLines, 1000);
  await mkdir(join(root, ".pi"));
  await writeFile(join(root, ".pi", CONFIG_FILENAME), "not json");
  assert.equal((await loadSessionPolicy(root, false, (message) => warnings.push(message))).maxLines, 1000);
  assert.deepEqual(warnings, []);
});

test("invalid config falls back atomically and emits one warning callback", async () => {
  for (const value of [
    "not json",
    JSON.stringify({ maxLines: 10, extra: true }),
    JSON.stringify({ maxLines: -1 }),
    JSON.stringify({ significantGrowthLines: 0 }),
    JSON.stringify({ include: [1] }),
  ]) {
    const root = await temporaryRoot();
    await mkdir(join(root, ".pi"));
    await writeFile(join(root, ".pi", CONFIG_FILENAME), value);
    const warnings: string[] = [];
    const policy = await loadSessionPolicy(root, true, (message) => warnings.push(message));
    assert.equal(policy.maxLines, 1000);
    assert.equal(policy.significantGrowthLines, 150);
    assert.deepEqual(warnings, [INVALID_CONFIG_WARNING]);
  }
});
