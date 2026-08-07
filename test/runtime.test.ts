import assert from "node:assert/strict";
import { link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { CONFIG_FILENAME } from "../src/config.ts";
import { formatNudge } from "../src/policy.ts";
import { registerSizeNudge } from "../src/runtime.ts";

type Handler = (event: any, ctx: any) => any;

const temporaryRoots: string[] = [];

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

after(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

class MockPi {
  handlers = new Map<string, Handler[]>();
  tools = ["edit", "write", "read", "grep", "find", "ls"].map((name) => ({
    name,
    sourceInfo: { path: `<builtin:${name}>`, source: "builtin", scope: "temporary", origin: "top-level" },
  }));
  sent: unknown[] = [];
  on(name: string, handler: Handler) { this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]); }
  getAllTools() { return this.tools; }
  sendMessage(message: unknown) { this.sent.push(message); }
  async emit(name: string, event: any, ctx: any) {
    let result;
    for (const handler of this.handlers.get(name) ?? []) result = await handler(event, ctx) ?? result;
    return result;
  }
}

async function setup(config: unknown = { maxLines: 3, significantGrowthLines: 2 }) {
  const root = await temporaryRoot("size-nudge-runtime-");
  await mkdir(join(root, ".pi"));
  await writeFile(join(root, ".pi", CONFIG_FILENAME), typeof config === "string" ? config : JSON.stringify(config));
  const pi = new MockPi();
  registerSizeNudge(pi as any, ".pi");
  const warnings: string[] = [];
  const ctx = {
    cwd: root,
    isProjectTrusted: () => true,
    hasUI: true,
    ui: { notify: (message: string) => warnings.push(message) },
  };
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  return { root, pi, ctx, warnings };
}

const writeSuccess = (path: string, content: string, extra: Record<string, unknown> = {}) => ({
  type: "tool_result", toolName: "write", toolCallId: "id", input: { path, content },
  content: [{ type: "text", text: `Successfully wrote ${content.length} bytes to ${path}` }],
  details: undefined, isError: false, ...extra,
});

async function invoke(pi: MockPi, ctx: any, event: any) {
  await pi.emit("tool_execution_start", { type: "tool_execution_start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.input }, ctx);
  await pi.emit("tool_call", { type: "tool_call", toolCallId: event.toolCallId, toolName: event.toolName, input: event.input }, ctx);
  const patch = await pi.emit("tool_result", event, ctx);
  await pi.emit("tool_execution_end", { type: "tool_execution_end", toolCallId: event.toolCallId, toolName: event.toolName, result: event, isError: event.isError }, ctx);
  return patch;
}

test("new built-in write gets one event-local nudge and preserves all other fields", async () => {
  const { root, pi, ctx } = await setup();
  const path = join(root, "new.ts");
  const event = writeSuccess(path, "1\n2\n3\n4", { usage: { input: 1 }, custom: "untouched" });
  const patch = await invoke(pi, ctx, event);
  assert.deepEqual(patch, { content: [...event.content, { type: "text", text: formatNudge(4, 3) }] });
  assert.equal(event.details, undefined);
  assert.equal(event.isError, false);
  assert.deepEqual(event.usage, { input: 1 });
});

test("prior result middleware does not hide a successful built-in mutation", async () => {
  const { root, pi, ctx } = await setup();
  const path = join(root, "middleware.ts");
  const event = writeSuccess(path, "1\n2\n3\n4", {
    content: [
      { type: "text", text: `Successfully wrote 7 bytes to ${path}` },
      { type: "text", text: "Earlier extension note" },
    ],
    details: { earlierExtension: true },
  });
  const patch = await invoke(pi, ctx, event);
  assert.deepEqual(patch, { content: [...event.content, { type: "text", text: formatNudge(4, 3) }] });
});

test("session policy governs an absolute external path", async () => {
  const { pi, ctx } = await setup();
  const externalRoot = await temporaryRoot("size-nudge-external-");
  const path = join(externalRoot, "outside.ts");
  const patch = await invoke(pi, ctx, writeSuccess(path, "1\n2\n3\n4"));
  assert.equal(patch.content.at(-1).text, formatNudge(4, 3));
});

test("existing writes cover crossing, significant growth, small growth, shrink, and exact maximum", async () => {
  const { root, pi, ctx } = await setup();
  const cases = [
    ["cross.ts", "1\n2\n3", "1\n2\n3\n4", true],
    ["grow.ts", "1\n2\n3\n4", "1\n2\n3\n4\n5\n6", true],
    ["small.ts", "1\n2\n3\n4", "1\n2\n3\n4\n5", false],
    ["shrink.ts", "1\n2\n3\n4\n5", "1\n2\n3\n4", false],
    ["max.ts", "1", "1\n2\n3", false],
  ] as const;
  for (const [name, before, after, nudged] of cases) {
    const path = join(root, name);
    await writeFile(path, before);
    const event = { ...writeSuccess(path, after), toolCallId: name };
    const patch = await invoke(pi, ctx, event);
    assert.equal(Boolean(patch), nudged, name);
  }
});

test("edit after-state is derived from built-in LF/CRLF/BOM semantics", async () => {
  const { root, pi, ctx } = await setup();
  const path = join(root, "edit.ts");
  await writeFile(path, "\uFEFFone\r\ntwo\r\nthree\r\n");
  const input = { path, edits: [{ oldText: "two\nthree", newText: "two\nthree\nfour" }] };
  const event = {
    type: "tool_result", toolName: "edit", toolCallId: "edit-id", input,
    content: [{ type: "text", text: `Successfully replaced 1 block(s) in ${path}.` }],
    details: { diff: "diff", patch: "patch", firstChangedLine: 2 }, isError: false,
  };
  const patch = await invoke(pi, ctx, event);
  assert.equal(patch.content.at(-1).text, formatNudge(4, 3, 1));
});

test("failed, unsupported, missing, overwritten-input, and non-built-in-shaped results are silent", async () => {
  const { root, pi, ctx } = await setup();
  const path = join(root, "x.ts");
  const failed = writeSuccess(path, "1\n2\n3\n4");
  failed.isError = true;
  assert.equal(await invoke(pi, ctx, failed), undefined);
  assert.equal(await invoke(pi, ctx, { ...writeSuccess(path, "1\n2\n3\n4"), toolName: "custom", toolCallId: "custom" }), undefined);
  assert.equal(await pi.emit("tool_result", writeSuccess(path, "1\n2\n3\n4"), ctx), undefined);

  const input = { path, content: "1\n2\n3\n4" };
  await pi.emit("tool_call", { type: "tool_call", toolName: "write", toolCallId: "changed", input }, ctx);
  input.content += "\n5";
  assert.equal(await pi.emit("tool_result", { ...writeSuccess(path, input.content), toolCallId: "changed", input }, ctx), undefined);

  assert.equal(await invoke(pi, ctx, {
    ...writeSuccess(path, "1\n2\n3\n4"),
    toolCallId: "bad",
    content: [{ type: "text", text: "Custom write completed" }],
  }), undefined);
});

test("built-in-compatible extra input fields remain observable", async () => {
  const { root, pi, ctx } = await setup();
  const path = join(root, "extra-fields.ts");
  await writeFile(path, "one\ntwo\nthree\n");
  const input = {
    path,
    edits: [{ oldText: "three", newText: "three\nfour", metadata: "ignored by built-in" }],
    metadata: "ignored by built-in",
  };
  const event = {
    type: "tool_result", toolName: "edit", toolCallId: "extra-fields", input,
    content: [{ type: "text", text: `Successfully replaced 1 block(s) in ${path}.` }],
    details: { diff: "diff", patch: "patch", firstChangedLine: 3 }, isError: false,
  };
  assert.ok(await invoke(pi, ctx, event));
});

test("turn cleanup releases attribution left by a call without a result hook", async () => {
  const { root, pi, ctx } = await setup();
  const path = join(root, "blocked.ts");
  const blocked = { ...writeSuccess(path, "1\n2\n3\n4"), toolCallId: "blocked" };
  await pi.emit("tool_execution_start", { type: "tool_execution_start", toolCallId: blocked.toolCallId, toolName: "write", args: blocked.input }, ctx);
  await pi.emit("tool_call", { type: "tool_call", toolCallId: blocked.toolCallId, toolName: "write", input: blocked.input }, ctx);
  await pi.emit("tool_execution_end", { type: "tool_execution_end", toolCallId: blocked.toolCallId, toolName: "write", result: blocked, isError: true }, ctx);
  await pi.emit("turn_end", { type: "turn_end" }, ctx);

  const next = { ...writeSuccess(path, "1\n2\n3\n4"), toolCallId: "next" };
  assert.ok(await invoke(pi, ctx, next));
});

test("parallel built-in read-only tools do not suppress an attributable write", async () => {
  const { root, pi, ctx } = await setup();
  const write = { ...writeSuccess(join(root, "with-read.ts"), "1\n2\n3\n4"), toolCallId: "write-with-read" };
  await pi.emit("tool_execution_start", { type: "tool_execution_start", toolCallId: write.toolCallId, toolName: "write", args: write.input }, ctx);
  await pi.emit("tool_call", { type: "tool_call", toolCallId: write.toolCallId, toolName: "write", input: write.input }, ctx);
  await pi.emit("tool_execution_start", { type: "tool_execution_start", toolCallId: "read-sibling", toolName: "read", args: { path: "other.ts" } }, ctx);
  await pi.emit("tool_call", { type: "tool_call", toolCallId: "read-sibling", toolName: "read", input: { path: "other.ts" } }, ctx);
  assert.ok(await pi.emit("tool_result", write, ctx));
});

test("hard-link, symlink, and missing-parent aliases are conservatively silent", async () => {
  const { root, pi, ctx } = await setup();
  const original = join(root, "original.ts");
  const hardLink = join(root, "hard-link.ts");
  const symbolicLink = join(root, "symbolic-link.ts");
  await writeFile(original, "1\n2\n3");
  await link(original, hardLink);
  await symlink(original, symbolicLink);
  const aliases = [original, hardLink, symbolicLink].map((path, index) => ({
    ...writeSuccess(path, `1\n2\n3\n4\n${index}`), toolCallId: `alias-${index}`,
  }));
  for (const event of aliases) {
    await pi.emit("tool_call", { type: "tool_call", toolName: "write", toolCallId: event.toolCallId, input: event.input }, ctx);
  }
  for (const event of aliases) assert.equal(await pi.emit("tool_result", event, ctx), undefined);

  const directory = join(root, "directory");
  const directoryAlias = join(root, "directory-alias");
  await mkdir(directory);
  await symlink(directory, directoryAlias);
  const missingAliases = [join(directory, "new.ts"), join(directoryAlias, "new.ts")].map((path, index) => ({
    ...writeSuccess(path, "1\n2\n3\n4"), toolCallId: `missing-alias-${index}`,
  }));
  for (const event of missingAliases) {
    await pi.emit("tool_call", { type: "tool_call", toolName: "write", toolCallId: event.toolCallId, input: event.input }, ctx);
  }
  for (const event of missingAliases) assert.equal(await pi.emit("tool_result", event, ctx), undefined);
});

test("new nested paths use the nearest existing canonical parent", async () => {
  const { root, pi, ctx } = await setup();
  const path = join(root, "missing", "nested", "large.ts");
  assert.ok(await invoke(pi, ctx, writeSuccess(path, "1\n2\n3\n4")));
});

test("special files fail open without observation", async () => {
  const { pi, ctx } = await setup();
  assert.equal(await invoke(pi, ctx, writeSuccess("/dev/null", "1\n2\n3\n4")), undefined);
});

test("same-path parallel siblings are both silent while different paths remain attributable", async () => {
  const { root, pi, ctx } = await setup();
  const path = join(root, "same.ts");
  const a = { ...writeSuccess(path, "1\n2\n3\n4"), toolCallId: "a" };
  const b = { ...writeSuccess(path, "1\n2\n3\n4\n5"), toolCallId: "b" };
  for (const event of [a, b]) {
    await pi.emit("tool_execution_start", { type: "tool_execution_start", toolCallId: event.toolCallId, toolName: "write", args: event.input }, ctx);
    await pi.emit("tool_call", { type: "tool_call", toolCallId: event.toolCallId, toolName: "write", input: event.input }, ctx);
  }
  assert.equal(await pi.emit("tool_result", b, ctx), undefined);
  assert.equal(await pi.emit("tool_result", a, ctx), undefined);

  const c = { ...writeSuccess(join(root, "c.ts"), "1\n2\n3\n4"), toolCallId: "c" };
  const d = { ...writeSuccess(join(root, "d.ts"), "1\n2\n3\n4"), toolCallId: "d" };
  await pi.emit("tool_call", { type: "tool_call", toolName: "write", toolCallId: "c", input: c.input }, ctx);
  await pi.emit("tool_call", { type: "tool_call", toolName: "write", toolCallId: "d", input: d.input }, ctx);
  assert.ok(await pi.emit("tool_result", d, ctx));
  assert.ok(await pi.emit("tool_result", c, ctx));
});

test("an unsupported sibling that starts and ends during observation still silences attribution", async () => {
  const { root, pi, ctx } = await setup();
  const path = join(root, "observation-race.ts");
  await writeFile(path, "1\n2\n3");
  const event = { ...writeSuccess(path, "1\n2\n3\n4"), toolCallId: "observed-write" };
  const observation = pi.emit("tool_call", { type: "tool_call", toolName: "write", toolCallId: event.toolCallId, input: event.input }, ctx);
  await pi.emit("tool_execution_start", { type: "tool_execution_start", toolCallId: "brief-bash", toolName: "bash", args: {} }, ctx);
  await pi.emit("tool_execution_end", { type: "tool_execution_end", toolCallId: "brief-bash", toolName: "bash" }, ctx);
  await observation;
  assert.equal(await pi.emit("tool_result", event, ctx), undefined);
});

test("an uncertain unsupported parallel sibling silences attribution in either preflight order", async () => {
  const { root, pi, ctx } = await setup();
  const first = { ...writeSuccess(join(root, "x.ts"), "1\n2\n3\n4"), toolCallId: "write-first" };
  await pi.emit("tool_call", { type: "tool_call", toolName: "write", toolCallId: first.toolCallId, input: first.input }, ctx);
  await pi.emit("tool_execution_start", { type: "tool_execution_start", toolCallId: "bash-after", toolName: "bash", args: {} }, ctx);
  assert.equal(await pi.emit("tool_result", first, ctx), undefined);
  await pi.emit("tool_execution_end", { type: "tool_execution_end", toolCallId: "bash-after", toolName: "bash" }, ctx);

  await pi.emit("tool_execution_start", { type: "tool_execution_start", toolCallId: "bash-before", toolName: "bash", args: {} }, ctx);
  const second = { ...writeSuccess(join(root, "y.ts"), "1\n2\n3\n4"), toolCallId: "write-second" };
  await pi.emit("tool_call", { type: "tool_call", toolName: "write", toolCallId: second.toolCallId, input: second.input }, ctx);
  assert.equal(await pi.emit("tool_result", second, ctx), undefined);
});

test("same-name custom overrides are rejected using public source metadata", async () => {
  const { root, pi, ctx } = await setup();
  pi.tools = pi.tools.map((tool) => tool.name === "write" ? { ...tool, sourceInfo: { path: "/custom.ts", source: "extension", scope: "project", origin: "top-level" } } : tool);
  const path = join(root, "override.ts");
  assert.equal(await invoke(pi, ctx, writeSuccess(path, "1\n2\n3\n4")), undefined);
});

test("malformed UTF-8 before-state and config loaded only once fail open", async () => {
  const { root, pi, ctx } = await setup();
  const path = join(root, "binary.ts");
  await writeFile(path, Buffer.from([0xff, 0xfe, 0x00]));
  assert.equal(await invoke(pi, ctx, writeSuccess(path, "1\n2\n3\n4")), undefined);

  await writeFile(join(root, ".pi", CONFIG_FILENAME), JSON.stringify({ maxLines: 100 }));
  await pi.emit("session_start", { type: "session_start", reason: "reload" }, ctx);
  const newPath = join(root, "still-three.ts");
  assert.ok(await invoke(pi, ctx, writeSuccess(newPath, "1\n2\n3\n4")));
  assert.equal(await readFile(join(root, ".pi", CONFIG_FILENAME), "utf8"), '{"maxLines":100}');
});
