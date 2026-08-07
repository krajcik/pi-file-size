import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { BenchmarkRunError, runBenchmark } from "../benchmark/harness.mjs";
import { DEFAULT_POLICY, evaluateMutation } from "../src/policy.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const benchmarkRoot = join(repositoryRoot, "benchmark");
const smokeConfig = join(benchmarkRoot, "smoke.config.json");
const expectedOss = new Map([
  ["oss-gin-context", ["34dac209ffb6ef85cc78c5d217bbb7ad001d68fd", "MIT", "Go"]],
  ["oss-click-core", ["00e592cea702e0b2caa0dee42489fdb1c22cd845", "BSD-3-Clause", "Python"]],
  ["oss-type-fest-package-json", ["548e7dfdbc8a70767cd278c0ec8512aef6e16b56", "CC0-1.0", "TypeScript"]],
  ["oss-requests-sessions", ["1f6589ec3a1ee910f9a65cc3ceac60b26677bc0e", "Apache-2.0", "Python"]],
  ["oss-httprouter-tree", ["484018016424d215c0b87c42f4c9b57d980fbd00", "BSD-3-Clause", "Go"]],
]);

async function temporaryDirectory() {
  return mkdtemp(join(tmpdir(), "pi-file-size-benchmark-test-"));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function descriptorSha256(task) {
  return createHash("sha256").update(stableJson(task)).digest("hex");
}

function physicalLines(content) {
  return content === "" ? 0 : content.split(/\r\n|\r|\n/).length;
}

function exactRequestedOutput(taskId, before) {
  if (taskId === "synthetic-ts-separable-growth") return [before, "function formatReport(value: string): string { return `Report: ${value}`; }", "export { formatReport };"].join("\n");
  if (taskId === "synthetic-python-false-positive") return before.replace(/\n}$/, "\n    \"tau\": \"Inspect an item\",\n}");
  if (taskId === "synthetic-ts-declarative-no-split") return before.replace(/\n}$/, "\n  benchmarkField?: string;\n}");
  if (taskId === "synthetic-go-legacy-growth") {
    const lines = ["var auditRules = map[string]bool{"];
    for (let index = 1; index <= 150; index++) lines.push(`\t\"rule-${String(index).padStart(3, "0")}\": true,`);
    lines.push("}", "", "func (Server) Audit() string { return \"audit\" }");
    return `${before}\n${lines.join("\n")}`;
  }
  if (taskId === "synthetic-go-boundary-extraction") {
    const lines = ["var routePriorities = map[string]int{"];
    for (let index = 1; index <= 150; index++) lines.push(`\t\"/route/${String(index).padStart(3, "0")}\": ${index},`);
    lines.push("}", "", "func routePriority(path string) int {", "\tif path == \"\" { return 0 }", "\treturn routePriorities[path]", "}");
    return `${before}\n${lines.join("\n")}`;
  }
  throw new Error(`unknown controlled task ${taskId}`);
}

async function generatedSynthetic(task) {
  const root = await temporaryDirectory();
  const setup = join(benchmarkRoot, task.fixture, task.setupCommand[1]);
  const result = spawnSync(process.execPath, [setup], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return { root, content: await readFile(join(root, task.target), "utf8") };
}

function controlledCheck(task, root) {
  const checker = join(benchmarkRoot, task.fixture, task.checkCommand[1]);
  const env = { ...process.env, GOPATH: join(root, ".gopath"), GOCACHE: join(root, ".gocache") };
  delete env.PI_BENCHMARK_SENTINEL_SECRET;
  delete env.PYTHONPATH;
  delete env.NODE_PATH;
  return spawnSync(process.execPath, [checker], { cwd: root, env, encoding: "utf8" });
}

async function derivedConfig(root, mutate) {
  const config = JSON.parse(await readFile(smokeConfig, "utf8"));
  config.output = join(root, "report.json");
  config.variants.candidate.extension.path = join(repositoryRoot, "extensions", "size-nudge.ts");
  config.variants.candidate.extension.sourcePaths = config.variants.candidate.extension.sourcePaths.map((sourcePath) => resolve(benchmarkRoot, sourcePath));
  delete config.variants.candidate.extension.sourceSha256;
  for (const family of config.families) {
    family.executorCommand[0] = process.execPath;
    family.executorCommand[1] = join(benchmarkRoot, "fixtures", "fake-adapter.mjs");
    family.judgeCommand[0] = process.execPath;
    family.judgeCommand[1] = join(benchmarkRoot, "fixtures", "fake-adapter.mjs");
  }
  mutate?.(config);
  const path = join(root, "config.json");
  await writeFile(path, JSON.stringify(config));
  return { config, path };
}

test("frozen corpus has required pins, licenses, exact acceptance metadata, languages, and scenarios", async () => {
  const corpus = JSON.parse(await readFile(join(benchmarkRoot, "corpus.json"), "utf8"));
  assert.equal(corpus.tasks.length, 10);
  assert.equal(corpus.tasks.filter((task) => task.kind === "synthetic").length, 5);
  assert.equal(corpus.tasks.filter((task) => task.kind === "oss").length, 5);
  assert.equal(new Set(corpus.tasks.map((task) => task.id)).size, 10);

  for (const task of corpus.tasks) {
    assert.ok(task.revision.length > 0);
    assert.ok(task.checkCommand.length > 0);
    assert.ok(task.prompt.length > 0);
    assert.ok(task.acceptanceCriteria.length >= 3);
    assert.doesNotMatch(task.prompt, /requested (?:behavior|enhancement|declaration)/i);
    if (task.kind === "oss") {
      assert.deepEqual([task.revision, task.license, task.language], expectedOss.get(task.id));
      assert.match(task.revision, /^[0-9a-f]{40}$/);
      assert.match(task.repository, /^https:\/\/github\.com\//);
      if (task.language === "Python") assert.equal(task.checkCommand[0], "python3");
      assert.equal(task.acceptanceCheckCommand[0], "node");
      assert.match(task.acceptanceCheckCommand[1], /^acceptance\/[a-z-]+\.mjs$/);
      assert.equal(spawnSync(process.execPath, ["--check", join(benchmarkRoot, task.acceptanceCheckCommand[1])]).status, 0);
    } else {
      assert.deepEqual(task.setupCommand, ["node", "setup.mjs"]);
    }
  }

  assert.deepEqual([...new Set(corpus.tasks.map((task) => task.language))].sort(), ["Go", "Python", "TypeScript"]);
  const tags = new Set(corpus.tasks.flatMap((task) => task.scenarioTags));
  for (const required of ["separable-growth", "legacy-growth", "false-positive-pressure", "cohesive-no-split", "declarative", "cohesive-extraction"]) assert.ok(tags.has(required));
  assert.match(corpus.tasks.find((task) => task.id === "oss-type-fest-package-json").prompt, /boolean `provenance`.*PublishConfig/);
  assert.doesNotMatch(corpus.tasks.find((task) => task.id === "oss-type-fest-package-json").prompt, /devEngines/);
  assert.match(corpus.tasks.find((task) => task.id === "oss-httprouter-tree").prompt, /countStaticSegments/);
  assert.doesNotMatch(corpus.tasks.find((task) => task.id === "oss-httprouter-tree").prompt, /countParams/);
});

test("compact generators materialize default-threshold scenarios with intended policy triggers", async () => {
  const corpus = JSON.parse(await readFile(join(benchmarkRoot, "corpus.json"), "utf8"));
  const tasks = corpus.tasks.filter((task) => task.kind === "synthetic");
  const expectations = new Map([
    ["synthetic-ts-separable-growth", [999, 1001, true]],
    ["synthetic-go-legacy-growth", [1050, 1204, true]],
    ["synthetic-python-false-positive", [1000, 1001, true]],
    ["synthetic-ts-declarative-no-split", [1100, 1101, false]],
    ["synthetic-go-boundary-extraction", [1001, 1158, true]],
  ]);
  const roots = [];
  try {
    for (const task of tasks) {
      const generated = await generatedSynthetic(task);
      roots.push(generated.root);
      const [beforeLines, afterLines, nudged] = expectations.get(task.id);
      assert.equal(physicalLines(generated.content), beforeLines, task.id);
      const after = exactRequestedOutput(task.id, generated.content);
      assert.equal(physicalLines(after), afterLines, `${task.id} requested output line count`);
      const policy = { ...DEFAULT_POLICY, projectRoot: generated.root };
      assert.equal(Boolean(evaluateMutation({ path: join(generated.root, task.target), before: generated.content, after, policy })), nudged, task.id);
      await writeFile(join(generated.root, task.target), after);
      assert.equal(controlledCheck(task, generated.root).status, 0, `${task.id} exact direct implementation must pass`);
      assert.ok((await readFile(join(benchmarkRoot, task.fixture, "setup.mjs"), "utf8")).length < 1000, "generator should remain compact");
    }
  } finally {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  }
});

test("controlled acceptance checks reject spoofed, wrong, required, unrelated, and malformed changes", async () => {
  const corpus = JSON.parse(await readFile(join(benchmarkRoot, "corpus.json"), "utf8"));
  const task = (id) => corpus.tasks.find((candidate) => candidate.id === id);
  const roots = [];
  try {
    for (const [id, extractedFile, packageName] of [
      ["synthetic-go-legacy-growth", "audit.go", "legacy"],
      ["synthetic-go-boundary-extraction", "priority.go", "router"],
    ]) {
      const extracted = await generatedSynthetic(task(id));
      roots.push(extracted.root);
      const direct = exactRequestedOutput(id, extracted.content);
      await writeFile(join(extracted.root, extractedFile), `package ${packageName}\n\n${direct.slice(extracted.content.length + 1)}\n`);
      assert.equal(controlledCheck(task(id), extracted.root).status, 0, `${id} cohesive extraction must pass`);
    }

    const spoof = await generatedSynthetic(task("synthetic-ts-separable-growth"));
    roots.push(spoof.root);
    await writeFile(join(spoof.root, "src", "index.ts"), `${spoof.content}\n// formatReport returns Report: value`);
    assert.notEqual(controlledCheck(task("synthetic-ts-separable-growth"), spoof.root).status, 0, "comment spoof must fail");

    const wrong = await generatedSynthetic(task("synthetic-go-legacy-growth"));
    roots.push(wrong.root);
    await writeFile(join(wrong.root, "audit.go"), "package legacy\n\nfunc (Server) Audit() string { return \"wrong\" }\n");
    assert.notEqual(controlledCheck(task("synthetic-go-legacy-growth"), wrong.root).status, 0, "wrong return must fail");

    const required = await generatedSynthetic(task("synthetic-ts-declarative-no-split"));
    roots.push(required.root);
    await writeFile(join(required.root, "package-json.d.ts"), required.content.replace(/\n}$/, "\n  benchmarkField: string;\n}"));
    assert.notEqual(controlledCheck(task("synthetic-ts-declarative-no-split"), required.root).status, 0, "required field must fail");

    const unrelated = await generatedSynthetic(task("synthetic-python-false-positive"));
    roots.push(unrelated.root);
    const validRegistry = exactRequestedOutput("synthetic-python-false-positive", unrelated.content);
    await writeFile(join(unrelated.root, "registry.py"), `${validRegistry}\nUNRELATED = True`);
    assert.notEqual(controlledCheck(task("synthetic-python-false-positive"), unrelated.root).status, 0, "unrelated edit must fail");

    const malformed = await generatedSynthetic(task("synthetic-go-boundary-extraction"));
    roots.push(malformed.root);
    await writeFile(join(malformed.root, "priority.go"), "package router\n\nfunc routePriority(path string) int {\n");
    assert.notEqual(controlledCheck(task("synthetic-go-boundary-extraction"), malformed.root).status, 0, "malformed output must fail");
  } finally {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  }
});

test("offline E2E judges blind artifacts, exercises the real extension, ties identical artifacts, and has independent family summaries", async () => {
  const root = await temporaryDirectory();
  const injectedEnvironment = ["PI_BENCHMARK_SENTINEL_SECRET", "PYTHONPATH", "NODE_PATH", "GOPATH", "GOCACHE"];
  const previousEnvironment = Object.fromEntries(injectedEnvironment.map((name) => [name, process.env[name]]));
  for (const name of injectedEnvironment) process.env[name] = `host-${name.toLowerCase()}`;
  try {
    const first = (await runBenchmark(smokeConfig, { output: join(root, "first.json") })).report;
    const second = (await runBenchmark(smokeConfig, { output: join(root, "second.json") })).report;
    assert.deepEqual(JSON.parse(await readFile(join(root, "first.json"), "utf8")), first);
    assert.deepEqual(
      first.records.map(({ randomizedOrder, verdict, executorFamily, judgeFamily }) => ({ randomizedOrder, verdict, executorFamily, judgeFamily })),
      second.records.map(({ randomizedOrder, verdict, executorFamily, judgeFamily }) => ({ randomizedOrder, verdict, executorFamily, judgeFamily })),
    );
    assert.equal(first.records.length, 4);
    assert.ok(new Set(first.records.map((record) => record.randomizedOrder.join(","))).size > 1);

    for (const record of first.records) {
      assert.notEqual(record.executorFamily, record.judgeFamily);
      assert.ok(record.candidateRevision && record.baselineRevision && record.taskRevision);
      assert.match(record.taskDescriptorSha256, /^[0-9a-f]{64}$/);
      assert.match(record.candidateExtension.sourceSha256, /^[0-9a-f]{64}$/);
      assert.match(record.candidateExtension.configSha256, /^[0-9a-f]{64}$/);
      assert.match(record.candidateExtension.effectiveSha256, /^[0-9a-f]{64}$/);
      assert.match(record.executorAnswers.candidate, /AUDITED EXECUTOR PROSE/);
      assert.doesNotMatch(record.artifacts.candidate, /AUDITED EXECUTOR PROSE|pi-file-size-benchmark-|\/Users\//);
      assert.doesNotMatch(record.artifacts.baseline, /AUDITED EXECUTOR PROSE|pi-file-size-benchmark-|\/Users\//);
      assert.ok(record.runtimeMs.candidate >= 0 && record.runtimeMs.baseline >= 0);
      if (record.rationale?.startsWith("Automatic tie:")) {
        assert.equal(record.runtimeMs.judge, null);
        assert.equal(record.tokenUsage.judge, null);
      } else assert.ok(record.runtimeMs.judge >= 0);
      assert.ok(Object.hasOwn(record.tokenUsage, "candidate") && Object.hasOwn(record.tokenUsage, "baseline") && Object.hasOwn(record.tokenUsage, "judge"));
      assert.equal(record.deterministicChecks.candidate.status, "passed");
      assert.equal(record.deterministicChecks.baseline.status, "passed");
      assert.equal(record.deterministicChecks.candidate.upstream.status, "passed");
      assert.equal(record.deterministicChecks.candidate.acceptance.status, "not-applicable");
    }

    const crossing = first.records.filter((record) => record.taskId === "synthetic-ts-separable-growth");
    assert.ok(crossing.every((record) => record.observedSignals.candidate.sizeNudge === true && record.observedSignals.baseline.sizeNudge === false));
    const declarative = first.records.filter((record) => record.taskId === "synthetic-ts-declarative-no-split");
    assert.ok(declarative.every((record) => record.observedSignals.candidate.sizeNudge === false));
    assert.ok(declarative.every((record) => record.artifactSha256.candidate === record.artifactSha256.baseline && record.verdict === "tie"));

    assert.equal(first.summary.candidateWins, 1);
    assert.equal(first.summary.baselineWins, 0);
    assert.equal(first.summary.ties, 3);
    assert.equal(first.summary.pairwiseWinRate, 0.625);
    assert.deepEqual(first.summary.executorFamilies.map(({ wins, losses, ties, rate }) => ({ wins, losses, ties, rate })), [
      { wins: 1, losses: 0, ties: 1, rate: 0.75 },
      { wins: 0, losses: 0, ties: 2, rate: 0.5 },
    ]);
    assert.equal(first.variants.candidate.revision, "pi-5-manual-champion-v1");
    assert.deepEqual(first.variants.candidate.extension.sourcePaths, [
      "../extensions/size-nudge.ts",
      "../src/config.ts",
      "../src/edit-semantics.ts",
      "../src/policy.ts",
      "../src/runtime.ts",
    ]);
    assert.equal(first.variants.candidate.extension.sourceSha256, "dc8f8fc8ef17e4e2560245674a31bdc427e807630fd280abe8abefc92e13a3db");
    assert.deepEqual(first.variants.candidate.extension.config, { maxLines: 1000, significantGrowthLines: 150, include: [], exclude: [] });
  } finally {
    for (const name of injectedEnvironment) {
      if (previousEnvironment[name] === undefined) delete process.env[name];
      else process.env[name] = previousEnvironment[name];
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("task descriptor digest changes when a custom corpus descriptor changes", async () => {
  const root = await temporaryDirectory();
  try {
    const corpus = JSON.parse(await readFile(join(benchmarkRoot, "corpus.json"), "utf8"));
    const task = structuredClone(corpus.tasks.find((candidate) => candidate.id === "synthetic-ts-separable-growth"));
    task.fixture = join(benchmarkRoot, task.fixture);
    const originalDigest = descriptorSha256(task);
    task.prompt += " Preserve the exact public formatter signature.";
    const changedDigest = descriptorSha256(task);
    assert.notEqual(changedDigest, originalDigest);
    const corpusPath = join(root, "custom-corpus.json");
    await writeFile(corpusPath, JSON.stringify({ schemaVersion: 1, tasks: [task] }));
    const { path } = await derivedConfig(root, (value) => {
      value.corpus = corpusPath;
      value.tasks = [task.id];
    });
    const report = (await runBenchmark(path)).report;
    assert.ok(report.records.every((record) => record.taskDescriptorSha256 === changedDigest));
    assert.ok(report.records.every((record) => record.taskDescriptorSha256 !== originalDigest));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("acceptance failures retain independent upstream attribution", async () => {
  const root = await temporaryDirectory();
  try {
    const corpus = JSON.parse(await readFile(join(benchmarkRoot, "corpus.json"), "utf8"));
    const task = structuredClone(corpus.tasks.find((candidate) => candidate.id === "synthetic-ts-separable-growth"));
    task.fixture = join(benchmarkRoot, task.fixture);
    task.acceptanceCheckCommand = ["node", join(benchmarkRoot, "acceptance", "fail-for-test.mjs")];
    const corpusPath = join(root, "acceptance-corpus.json");
    await writeFile(corpusPath, JSON.stringify({ schemaVersion: 1, tasks: [task] }));
    const { config, path } = await derivedConfig(root, (value) => {
      value.corpus = corpusPath;
      value.tasks = [task.id];
    });
    await assert.rejects(runBenchmark(path), BenchmarkRunError);
    const report = JSON.parse(await readFile(config.output, "utf8"));
    for (const record of report.records) {
      for (const detail of Object.values(record.deterministicChecks)) {
        assert.equal(detail.upstream.status, "passed");
        assert.equal(detail.acceptance.status, "failed");
        assert.equal(detail.acceptance.exitCode, 7);
        assert.match(detail.acceptance.error, /controlled acceptance failure/);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("candidate source pin mismatches are rejected before execution", async () => {
  const root = await temporaryDirectory();
  try {
    const { path } = await derivedConfig(root, (value) => {
      value.variants.candidate.extension.sourceSha256 = "0".repeat(64);
    });
    await assert.rejects(runBenchmark(path), /sourceSha256 mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a no-op candidate extension loses the real package-behavior signal", async () => {
  const root = await temporaryDirectory();
  try {
    const { config, path } = await derivedConfig(root, (value) => {
      value.tasks = ["synthetic-ts-separable-growth"];
      value.variants.candidate.revision = "broken-noop";
      value.variants.candidate.extension.path = join(benchmarkRoot, "fixtures", "noop-extension.mjs");
      value.variants.candidate.extension.sourcePaths = [value.variants.candidate.extension.path];
      delete value.variants.candidate.extension.sourceSha256;
    });
    const report = (await runBenchmark(path)).report;
    assert.equal(report.summary.candidateWins, 0);
    assert.equal(report.summary.ties, 2);
    assert.ok(report.records.every((record) => record.observedSignals.candidate.sizeNudge === false));
    assert.ok(report.records.every((record) => record.artifactSha256.candidate === record.artifactSha256.baseline));
    assert.deepEqual(JSON.parse(await readFile(config.output, "utf8")), report);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an independently failing deterministic check writes a report and fails the run", async () => {
  const root = await temporaryDirectory();
  try {
    const { config, path } = await derivedConfig(root, (value) => {
      value.tasks = ["synthetic-ts-separable-growth"];
      for (const family of value.families) family.executorCommand.push("fail-check");
    });
    await assert.rejects(runBenchmark(path), (error) => error instanceof BenchmarkRunError && error.report.records.every((record) => record.verdict === "invalid"));
    const report = JSON.parse(await readFile(config.output, "utf8"));
    assert.equal(report.summary.deterministicGatePassed, false);
    assert.equal(report.records.length, 2);
    for (const record of report.records) {
      assert.equal(record.deterministicChecks.candidate.status, "failed");
      assert.equal(record.deterministicChecks.baseline.status, "failed");
      assert.equal(record.runtimeMs.judge, null);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("every distinctive treatment field is rejected when echoed in UTF-8 or binary artifacts", async () => {
  const leakBehaviors = [
    "leak-entrypoint", "leak-source-path", "leak-source-digest", "leak-source-digest-binary",
    "leak-config-digest", "leak-effective-digest", "leak-config",
  ];
  for (const behavior of leakBehaviors) {
    const root = await temporaryDirectory();
    try {
      const { config, path } = await derivedConfig(root, (value) => {
        value.tasks = ["synthetic-ts-separable-growth"];
        for (const family of value.families) family.executorCommand.push(behavior);
      });
      await assert.rejects(runBenchmark(path), (error) => error instanceof BenchmarkRunError && /artifact leakage detected/.test(error.message));
      const report = JSON.parse(await readFile(config.output, "utf8"));
      assert.ok(report.records.every((record) => record.artifactLeaks.candidate), behavior);
      assert.ok(report.records.every((record) => record.runtimeMs.judge === null && record.tokenUsage.judge === null), behavior);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("workspace capture rejects sparse files and bounded file, empty-directory, and depth traversal", async () => {
  const expectations = new Map([
    ["oversized", /file exceeded/],
    ["many-files", /file count exceeded/],
    ["many-empty-dirs", /directory count exceeded/],
    ["deep-empty-dirs", /depth exceeded/],
  ]);
  for (const [behavior, expectedError] of expectations) {
    const root = await temporaryDirectory();
    try {
      const { path } = await derivedConfig(root, (value) => {
        value.tasks = ["synthetic-ts-separable-growth"];
        for (const family of value.families) family.executorCommand.push(behavior);
      });
      await assert.rejects(runBenchmark(path), (error) => {
        if (!(error instanceof BenchmarkRunError)) return false;
        const messages = error.report.records.map((record) => record.executionErrors.candidate).filter(Boolean).join("\n");
        return expectedError.test(messages);
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("split multibyte adapter output is decoded once after process close", async () => {
  const root = await temporaryDirectory();
  try {
    const { path } = await derivedConfig(root, (value) => {
      value.tasks = ["synthetic-ts-separable-growth"];
      for (const family of value.families) family.executorCommand.push("split-utf8");
    });
    const report = (await runBenchmark(path)).report;
    assert.ok(report.records.every((record) => record.executorAnswers.candidate.includes("🧪") && record.executorAnswers.baseline.includes("🧪")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed token usage and oversized observed signals are rejected", async () => {
  for (const role of ["executor", "judge", "signal"]) {
    const root = await temporaryDirectory();
    try {
      const { path } = await derivedConfig(root, (value) => {
        value.tasks = ["synthetic-ts-separable-growth"];
        for (const family of value.families) {
          if (role === "executor") family.executorCommand.push("bad-usage");
          else if (role === "judge") family.judgeCommand.push("bad-usage");
          else family.executorCommand.push("bad-signal");
        }
      });
      await assert.rejects(runBenchmark(path), (error) => {
        if (!(error instanceof BenchmarkRunError)) return false;
        const messages = role === "judge"
          ? error.message
          : error.report.records.flatMap((record) => Object.values(record.executionErrors)).filter(Boolean).join("\n");
        return role === "signal" ? /oversized string/.test(messages) : /tokenUsage/.test(messages);
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("POSIX SIGINT cancels the active process group without permanent imported listeners", { skip: process.platform === "win32" }, async () => {
  const root = await temporaryDirectory();
  try {
    const pidPath = join(root, "cancel-descendant.pid");
    const hanging = join(benchmarkRoot, "fixtures", "hanging-descendant-adapter.mjs");
    const { path } = await derivedConfig(root, (value) => {
      value.tasks = ["synthetic-ts-separable-growth"];
      value.timeoutMs = 10000;
      for (const family of value.families) family.executorCommand = [process.execPath, hanging, pidPath];
    });
    const beforeListeners = { sigint: process.listenerCount("SIGINT"), sigterm: process.listenerCount("SIGTERM") };
    const child = spawn(process.execPath, [join(benchmarkRoot, "harness.mjs"), "--config", path], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    let descendantPid;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { descendantPid = Number(await readFile(pidPath, "utf8")); break; } catch { await new Promise((resolvePromise) => setTimeout(resolvePromise, 20)); }
    }
    assert.ok(descendantPid, "hanging descendant did not start");
    child.kill("SIGINT");
    const closed = await new Promise((resolvePromise) => child.on("close", (code, signal) => resolvePromise({ code, signal })));
    assert.deepEqual(closed, { code: 130, signal: null }, stderr);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    assert.throws(() => process.kill(descendantPid, 0), (error) => error.code === "ESRCH");
    assert.deepEqual({ sigint: process.listenerCount("SIGINT"), sigterm: process.listenerCount("SIGTERM") }, beforeListeners);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("POSIX cancellation interrupts bounded snapshot traversal as AbortError", { skip: process.platform === "win32" }, async () => {
  const root = await temporaryDirectory();
  try {
    const readyPath = join(root, "snapshot-ready");
    const { config, path } = await derivedConfig(root, (value) => {
      value.tasks = ["synthetic-ts-separable-growth"];
      value.timeoutMs = 20000;
      for (const family of value.families) family.executorCommand.push(`snapshot-cancel:${readyPath}`);
    });
    const child = spawn(process.execPath, [join(benchmarkRoot, "harness.mjs"), "--config", path], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    let ready = false;
    for (let attempt = 0; attempt < 500; attempt++) {
      try { await readFile(readyPath); ready = true; break; } catch { await new Promise((resolvePromise) => setTimeout(resolvePromise, 10)); }
    }
    assert.equal(ready, true, "snapshot fixture did not become ready");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    child.kill("SIGTERM");
    const closed = await new Promise((resolvePromise) => child.on("close", (code, signal) => resolvePromise({ code, signal })));
    assert.deepEqual(closed, { code: 130, signal: null }, stderr);
    await assert.rejects(readFile(config.output), (error) => error.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("POSIX timeout kills the adapter process group before workspace cleanup", { skip: process.platform === "win32" }, async () => {
  const root = await temporaryDirectory();
  try {
    const pidPath = join(root, "descendant.pid");
    const hanging = join(benchmarkRoot, "fixtures", "hanging-descendant-adapter.mjs");
    const { path } = await derivedConfig(root, (value) => {
      value.tasks = ["synthetic-ts-separable-growth"];
      value.timeoutMs = 300;
      for (const family of value.families) family.executorCommand = [process.execPath, hanging, pidPath];
    });
    await assert.rejects(runBenchmark(path), BenchmarkRunError);
    const pid = Number(await readFile(pidPath, "utf8"));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    assert.throws(() => process.kill(pid, 0), (error) => error.code === "ESRCH");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
