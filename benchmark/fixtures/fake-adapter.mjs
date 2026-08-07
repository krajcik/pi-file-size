import { register } from "node:module";
import { mkdir, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

register("./peer-loader.mjs", import.meta.url);

const [mode, familyId, behavior = "pass"] = process.argv.slice(2);
let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);

function assertBlind(value) {
  if (Array.isArray(value)) {
    for (const item of value) assertBlind(item);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      if (["variant", "revision", "extension", "familyId", "candidate", "baseline", "answer", "workspace"].includes(key)) throw new Error(`judge request disclosed ${key}`);
      assertBlind(nested);
    }
    return;
  }
  if (typeof value === "string" && (
    /pi-file-size-benchmark-|AUDITED EXECUTOR PROSE|family-[ab]|working-tree|\/Users\//.test(value)
    || new Set(["pi-file-size", "no-extension", "7022c5d", "baseline-v1"]).has(value)
  )) throw new Error("judge request disclosed execution identity or a temporary path");
}

class MockPi {
  handlers = new Map();
  tools = ["edit", "write", "read", "grep", "find", "ls"].map((name) => ({
    name,
    sourceInfo: { path: `<builtin:${name}>`, source: "builtin", scope: "temporary", origin: "top-level" },
  }));
  on(name, handler) { this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]); }
  getAllTools() { return this.tools; }
  async emit(name, event, context) {
    let result;
    for (const handler of this.handlers.get(name) ?? []) result = await handler(event, context) ?? result;
    return result;
  }
}

function auditBody() {
  return [
    "var auditRules = map[string]bool{",
    ...Array.from({ length: 150 }, (_, index) => `\t\"rule-${String(index + 1).padStart(3, "0")}\": true,`),
    "}",
    "",
    "func (Server) Audit() string { return \"audit\" }",
  ].join("\n");
}

function priorityBody() {
  return [
    "var routePriorities = map[string]int{",
    ...Array.from({ length: 150 }, (_, index) => `\t\"/route/${String(index + 1).padStart(3, "0")}\": ${index + 1},`),
    "}",
    "",
    "func routePriority(path string) int {",
    "\tif path == \"\" { return 0 }",
    "\treturn routePriorities[path]",
    "}",
  ].join("\n");
}

function requestedMutation(taskId, before) {
  if (taskId === "synthetic-ts-separable-growth") return [before, "function formatReport(value: string): string { return `Report: ${value}`; }", "export { formatReport };"].join("\n");
  if (taskId === "synthetic-go-legacy-growth") return `${before}\n${auditBody()}`;
  if (taskId === "synthetic-python-false-positive") return before.replace(/\n}$/, "\n    \"tau\": \"Inspect an item\",\n}");
  if (taskId === "synthetic-ts-declarative-no-split") return before.replace(/\n}$/, "\n  benchmarkField?: string;\n}");
  if (taskId === "synthetic-go-boundary-extraction") return `${before}\n${priorityBody()}`;
  throw new Error(`fake executor cannot run ${taskId}`);
}

async function observeActualExtension(request, before, after) {
  const pi = new MockPi();
  if (request.extension !== null) {
    await mkdir(join(request.workspace, ".pi"), { recursive: true });
    await writeFile(join(request.workspace, ".pi", "size-nudge.json"), JSON.stringify(request.extension.config));
    const module = await import(`${pathToFileURL(request.extension.path).href}?benchmark=${request.extension.sourceSha256}`);
    if (typeof module.default !== "function") throw new Error("candidate extension has no default registration function");
    module.default(pi);
  }
  const context = { cwd: request.workspace, isProjectTrusted: () => true, hasUI: false, ui: { notify() {} } };
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, context);
  if (request.extension !== null) await rm(join(request.workspace, ".pi"), { recursive: true, force: true });
  const path = join(request.workspace, request.task.target);
  const input = { path, content: after };
  const callId = "benchmark-write";
  await pi.emit("tool_execution_start", { type: "tool_execution_start", toolCallId: callId, toolName: "write", args: input }, context);
  await pi.emit("tool_call", { type: "tool_call", toolCallId: callId, toolName: "write", input }, context);
  await writeFile(path, after);
  const event = {
    type: "tool_result",
    toolName: "write",
    toolCallId: callId,
    input,
    content: [{ type: "text", text: `Successfully wrote ${after.length} bytes to ${path}` }],
    details: undefined,
    isError: false,
  };
  const patch = await pi.emit("tool_result", event, context);
  await pi.emit("tool_execution_end", { type: "tool_execution_end", toolCallId: callId, toolName: "write", result: event, isError: false }, context);
  return Boolean(patch?.content?.some((item) => item?.type === "text" && item.text?.startsWith("Size nudge:")));
}

async function cohesiveFollowUp(request, before, observedSignal) {
  const taskId = request.task.id;
  if (!observedSignal) return;
  if (["synthetic-python-false-positive", "synthetic-ts-declarative-no-split"].includes(taskId)) return;
  if (familyId === "family-b") return;
  const target = join(request.workspace, request.task.target);
  if (taskId === "synthetic-ts-separable-growth") {
    await writeFile(target, `${before}\nexport { formatReport } from './report.ts';`);
    await writeFile(join(request.workspace, "src", "report.ts"), "export function formatReport(value: string): string { return `Report: ${value}`; }\n");
  } else if (taskId === "synthetic-go-legacy-growth") {
    await writeFile(target, before);
    await writeFile(join(request.workspace, "audit.go"), `package legacy\n\n${auditBody()}\n`);
  } else if (taskId === "synthetic-go-boundary-extraction") {
    await writeFile(target, before);
    await writeFile(join(request.workspace, "priority.go"), `package router\n\n${priorityBody()}\n`);
  }
}

function artifactScore(artifact) {
  const changes = JSON.parse(artifact);
  const paths = changes.map((change) => change.path);
  let score = 0;
  if (paths.some((path) => /(?:^|\/)(?:report\.ts|audit\.go|priority\.go)$/.test(path))) score += 3;
  if (paths.some((path) => /numeric-part-|part-[0-9]/.test(path))) score -= 4;
  return score;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function leakedValue(request) {
  if (!request.extension) return null;
  if (behavior === "leak-entrypoint") return request.extension.path;
  if (behavior === "leak-source-path") return request.extension.sourcePaths[0];
  if (behavior === "leak-source-digest" || behavior === "leak-source-digest-binary") return request.extension.sourceSha256;
  if (behavior === "leak-config-digest") return request.extension.configSha256;
  if (behavior === "leak-effective-digest") return request.extension.effectiveSha256;
  if (behavior === "leak-config") return stableJson(request.extension.config);
  return behavior === "leak" ? request.extension.path : null;
}

async function emitResponse(response) {
  const bytes = Buffer.from(JSON.stringify(response));
  if (behavior !== "split-utf8") {
    process.stdout.write(bytes);
    return;
  }
  const marker = Buffer.from("🧪");
  const index = bytes.indexOf(marker);
  process.stdout.write(bytes.subarray(0, index + 1));
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  process.stdout.write(bytes.subarray(index + 1));
}

if (mode === "executor") {
  if (Object.keys(request).sort().join(",") !== "extension,protocolVersion,task,taskRevision,workspace") throw new Error("unexpected executor request metadata");
  if (/candidate|baseline/i.test(basename(request.workspace))) throw new Error("workspace name disclosed treatment");
  let observedSignal = false;
  if (behavior !== "fail-check") {
    const target = join(request.workspace, request.task.target);
    const before = await readFile(target, "utf8");
    const after = requestedMutation(request.task.id, before);
    observedSignal = await observeActualExtension(request, before, after);
    await cohesiveFollowUp(request, before, observedSignal);
    const leaked = leakedValue(request);
    if (leaked !== null) {
      const bytes = behavior === "leak-source-digest-binary" ? Buffer.concat([Buffer.from([0, 255]), Buffer.from(leaked)]) : leaked;
      await writeFile(join(request.workspace, "leak.bin"), bytes);
    }
    if (behavior === "oversized" && request.extension) {
      const oversized = join(request.workspace, "oversized.bin");
      await writeFile(oversized, "");
      await truncate(oversized, 2 * 1024 * 1024 + 1);
    }
    if (behavior === "many-files" && request.extension) {
      const directory = join(request.workspace, "many");
      await mkdir(directory);
      for (let index = 0; index <= 5000; index++) await writeFile(join(directory, String(index)), "");
    }
    if (behavior === "many-empty-dirs" && request.extension) {
      const directory = join(request.workspace, "empty-directories");
      await mkdir(directory);
      for (let index = 0; index <= 1000; index++) await mkdir(join(directory, String(index)));
    }
    if (behavior === "deep-empty-dirs" && request.extension) {
      let directory = join(request.workspace, "deep");
      for (let index = 0; index < 34; index++) { await mkdir(directory); directory = join(directory, "next"); }
    }
    if (behavior.startsWith("snapshot-cancel:") && request.extension) {
      const directory = join(request.workspace, "snapshot-files");
      await mkdir(directory);
      for (let index = 0; index < 4900; index++) await writeFile(join(directory, String(index)), "");
      await writeFile(behavior.slice("snapshot-cancel:".length), "ready");
    }
  }
  const response = {
    answer: `AUDITED EXECUTOR PROSE 🧪 ${familyId}; semantic judging must ignore this identity-bearing text.`,
    observedSignal: { sizeNudge: observedSignal },
  };
  if (familyId === "family-a" && observedSignal) response.tokenUsage = { input: 17, output: 11 };
  if (behavior === "bad-usage") response.tokenUsage = { input: -1, output: 2 };
  if (behavior === "bad-signal") response.observedSignal = { value: "x".repeat(5000) };
  await emitResponse(response);
} else if (mode === "judge") {
  if (Object.keys(request).sort().join(",") !== "artifacts,task") throw new Error("judge request must contain only blind task context and artifacts");
  assertBlind(request);
  if (!Array.isArray(request.task.rubricPriority) || !request.task.rubricPriority[0]?.includes("cohesion")) throw new Error("rubric priority missing");
  const [first, second] = request.artifacts.map(({ artifact }) => artifact);
  let verdict = "tie";
  if (first !== second) {
    const firstScore = artifactScore(first);
    const secondScore = artifactScore(second);
    verdict = firstScore === secondScore ? "tie" : firstScore > secondScore ? "A" : "B";
  }
  const response = { verdict, rationale: "Compared only normalized implementation artifacts using cohesion, scope safety, then useful size reduction." };
  if (behavior === "bad-usage") response.tokenUsage = { input: 1.5, output: 2 };
  await emitResponse(response);
} else {
  throw new Error("expected executor or judge mode");
}
