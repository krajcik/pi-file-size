import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { loadSessionPolicy } from "./config.ts";
import { applyBuiltInEdit, type Replacement } from "./edit-semantics.ts";
import { DEFAULT_POLICY, evaluateMutation, type SessionPolicy } from "./policy.ts";

interface PiLike {
  on(name: string, handler: (event: any, ctx: any) => unknown): void;
  getAllTools(): Array<{ name: string; sourceInfo: { path: string; source: string; scope: string; origin: string } }>;
}

interface PendingMutation {
  id: string;
  toolName: "edit" | "write";
  input: Record<string, unknown>;
  path: string;
  mutationKey: string;
  before: string | undefined;
  after: string;
  uncertain: boolean;
}

function sessionDefaults(projectRoot = ""): SessionPolicy {
  return { ...DEFAULT_POLICY, include: [], exclude: [], projectRoot };
}

function isBuiltin(pi: PiLike, name: string): boolean {
  try {
    const tool = pi.getAllTools().find((candidate) => candidate.name === name);
    return tool?.sourceInfo.path === `<builtin:${name}>`
      && tool.sourceInfo.source === "builtin"
      && tool.sourceInfo.scope === "temporary"
      && tool.sourceInfo.origin === "top-level";
  } catch {
    return false;
  }
}

function isBuiltinReadOnly(pi: PiLike, name: string): boolean {
  return (name === "read" || name === "grep" || name === "find" || name === "ls") && isBuiltin(pi, name);
}

function resolveBuiltInPath(input: string, cwd: string): string | undefined {
  try {
    let path = input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
    if (path.startsWith("@")) path = path.slice(1);
    if (path === "~") path = homedir();
    else if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
    if (/^file:\/\//.test(path)) path = fileURLToPath(path);
    return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  } catch {
    return undefined;
  }
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === [...expected].sort()[index]);
}

function parseInput(toolName: "edit" | "write", input: unknown): { path: string; afterFrom: string | Replacement[] } | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  if (typeof value.path !== "string") return undefined;
  if (toolName === "write") {
    if (typeof value.content !== "string") return undefined;
    return { path: value.path, afterFrom: value.content };
  }
  if (!Array.isArray(value.edits) || value.edits.length === 0) return undefined;
  const edits: Replacement[] = [];
  for (const edit of value.edits) {
    if (typeof edit !== "object" || edit === null || Array.isArray(edit)) return undefined;
    const replacement = edit as Record<string, unknown>;
    if (typeof replacement.oldText !== "string" || typeof replacement.newText !== "string") return undefined;
    edits.push({ oldText: replacement.oldText, newText: replacement.newText });
  }
  return { path: value.path, afterFrom: edits };
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && ((error as { code?: string }).code === "ENOENT" || (error as { code?: string }).code === "ENOTDIR");
}

async function missingMutationKey(path: string): Promise<string | undefined> {
  let ancestor = path;
  const suffix: string[] = [];
  while (true) {
    try {
      await lstat(ancestor);
      try {
        const canonical = await realpath(ancestor);
        return `new:${join(canonical, ...suffix)}`;
      } catch {
        return undefined;
      }
    } catch (error) {
      if (!isMissing(error)) return undefined;
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) return undefined;
    suffix.unshift(basename(ancestor));
    ancestor = parent;
  }
}

async function readBefore(path: string, signal?: AbortSignal): Promise<{ content: string | undefined; mutationKey: string } | undefined> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile()) return undefined;
    const bytes = await readFile(path, { signal });
    const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return { content, mutationKey: `file:${metadata.dev}:${metadata.ino}` };
  } catch (error) {
    if (!isMissing(error)) return undefined;
    const mutationKey = await missingMutationKey(path);
    return mutationKey ? { content: undefined, mutationKey } : undefined;
  }
}

function hasTextContent(content: unknown, text: string): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((item) => typeof item === "object" && item !== null && !Array.isArray(item)
    && exactKeys(item as Record<string, unknown>, ["type", "text"])
    && (item as Record<string, unknown>).type === "text"
    && (item as Record<string, unknown>).text === text);
}

function hasBuiltInResultSignature(event: any, record: PendingMutation): boolean {
  if (event.isError !== false || event.toolName !== record.toolName || event.toolCallId !== record.id) return false;
  const rawPath = record.input.path as string;
  if (record.toolName === "write") {
    const content = record.input.content as string;
    return hasTextContent(event.content, `Successfully wrote ${content.length} bytes to ${rawPath}`);
  }
  if (!hasTextContent(event.content, `Successfully replaced ${(record.input.edits as unknown[]).length} block(s) in ${rawPath}.`)) return false;
  if (typeof event.details !== "object" || event.details === null || Array.isArray(event.details)) return false;
  const details = event.details as Record<string, unknown>;
  return typeof details.diff === "string"
    && typeof details.patch === "string"
    && (details.firstChangedLine === undefined || typeof details.firstChangedLine === "number");
}

export function registerSizeNudge(pi: PiLike, configDirName: string): void {
  let policy = sessionDefaults();
  let policyLoaded = false;
  const pending = new Map<string, PendingMutation>();
  const owners = new Map<string, Set<string>>();
  const uncertainExecutions = new Set<string>();
  let uncertaintyGeneration = 0;

  const invalidatePending = () => {
    for (const record of pending.values()) record.uncertain = true;
  };

  pi.on("session_start", async (_event, ctx) => {
    if (policyLoaded) return;
    policyLoaded = true;
    try {
      const trusted = ctx.isProjectTrusted() === true;
      policy = await loadSessionPolicy(ctx.cwd, trusted, (message) => ctx.ui.notify(message, "warning"), configDirName);
    } catch {
      policy = sessionDefaults(ctx.cwd);
    }
  });

  pi.on("tool_execution_start", (event) => {
    if (event.toolName !== "edit" && event.toolName !== "write") {
      if (!isBuiltinReadOnly(pi, event.toolName)) {
        uncertaintyGeneration++;
        uncertainExecutions.add(event.toolCallId);
        invalidatePending();
      }
      return;
    }
    if (!isBuiltin(pi, event.toolName)) {
      uncertainExecutions.add(event.toolCallId);
      invalidatePending();
    }
  });

  pi.on("tool_execution_end", (event) => {
    uncertainExecutions.delete(event.toolCallId);
    // Successful calls have already passed tool_result; blocked calls are cleared at turn_end.
  });

  pi.on("turn_end", () => {
    pending.clear();
    owners.clear();
    uncertainExecutions.clear();
  });

  pi.on("tool_call", async (event, ctx) => {
    try {
      if (event.toolName !== "edit" && event.toolName !== "write") {
        if (!isBuiltinReadOnly(pi, event.toolName)) {
          uncertaintyGeneration++;
          invalidatePending();
        }
        return;
      }
      if (!isBuiltin(pi, event.toolName) || pending.has(event.toolCallId)) {
        invalidatePending();
        return;
      }
      const parsed = parseInput(event.toolName, event.input);
      if (!parsed) return;
      const absolutePath = resolveBuiltInPath(parsed.path, ctx.cwd);
      if (!absolutePath) return;
      const observationGeneration = uncertaintyGeneration;
      const observed = await readBefore(absolutePath, ctx.signal);
      if (!observed) return;
      let after: string | undefined;
      if (event.toolName === "write") after = parsed.afterFrom as string;
      else if (observed.content !== undefined) after = applyBuiltInEdit(observed.content, parsed.afterFrom as Replacement[]);
      if (after === undefined) return;

      const record: PendingMutation = {
        id: event.toolCallId,
        toolName: event.toolName,
        input: structuredClone(event.input),
        path: absolutePath,
        mutationKey: observed.mutationKey,
        before: observed.content,
        after,
        uncertain: uncertainExecutions.size > 0 || observationGeneration !== uncertaintyGeneration,
      };
      const existing = owners.get(record.mutationKey) ?? new Set<string>();
      if (existing.size > 0) {
        record.uncertain = true;
        for (const id of existing) {
          const sibling = pending.get(id);
          if (sibling) sibling.uncertain = true;
        }
      }
      existing.add(record.id);
      owners.set(record.mutationKey, existing);
      pending.set(record.id, record);
    } catch {
      // Observation errors never alter tool execution.
    }
  });

  pi.on("tool_result", (event) => {
    const record = pending.get(event.toolCallId);
    if (!record) return;
    pending.delete(record.id);
    const pathOwners = owners.get(record.mutationKey);
    pathOwners?.delete(record.id);
    if (pathOwners?.size === 0) owners.delete(record.mutationKey);
    try {
      if (record.uncertain || !isBuiltin(pi, record.toolName)) return;
      if (!isDeepStrictEqual(event.input, record.input)) return;
      if (!hasBuiltInResultSignature(event, record)) return;
      const nudge = evaluateMutation({ path: record.path, before: record.before, after: record.after, policy });
      if (!nudge) return;
      return { content: [...event.content, { type: "text", text: nudge }] };
    } catch {
      return;
    }
  });
}
