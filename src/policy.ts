import { basename, isAbsolute, relative, resolve } from "node:path";

export interface SessionPolicy {
  maxLines: number;
  significantGrowthLines: number;
  include: string[];
  exclude: string[];
  projectRoot: string;
}

export interface ObservedMutation {
  path: string;
  before: string | undefined;
  after: string;
  policy: SessionPolicy;
}

export const DEFAULT_POLICY: SessionPolicy = Object.freeze({
  maxLines: 1000,
  significantGrowthLines: 150,
  include: [],
  exclude: [],
  projectRoot: "",
});

export const NUDGE_PREFIX = "Size nudge:";

export function formatNudge(afterLines: number, maxLines: number, netGrowth?: number): string {
  const growth = netGrowth === undefined ? "" : `; net growth +${netGrowth}`;
  return `${NUDGE_PREFIX} this eligible file is now ${afterLines} physical lines (soft maximum ${maxLines}${growth}). Consider a cohesive extraction only if the new behavior has a clear local boundary; do not split solely to reach a number or refactor unrelated legacy code.`;
}

export function countPhysicalLines(content: string): number {
  const text = content.replace(/^\uFEFF/, "");
  if (text.length === 0) return 0;
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const separators = normalized.match(/\n/g)?.length ?? 0;
  return separators + (normalized.endsWith("\n") ? 0 : 1);
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function globRegex(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        index++;
        if (pattern[index + 1] === "/") {
          index++;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

function pathCandidates(path: string, projectRoot: string): string[] {
  const resolvedPath = isAbsolute(path) ? resolve(path) : resolve(projectRoot || ".", path);
  const absolute = normalizePath(resolvedPath);
  const candidates = new Set([absolute, basename(absolute)]);
  if (projectRoot) {
    const rel = relative(resolve(projectRoot), resolvedPath);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
      candidates.add(normalizePath(rel || "."));
    }
  }
  return [...candidates];
}

function matchesExplicit(path: string, patterns: string[], projectRoot: string): boolean {
  const candidates = pathCandidates(path, projectRoot);
  return patterns.some((rawPattern) => {
    const pattern = normalizePath(rawPattern);
    const matcher = globRegex(pattern);
    return candidates.some((candidate) => matcher.test(candidate));
  });
}

const EXCLUDED_BASENAMES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb",
  "deno.lock", "Cargo.lock", "go.sum", "composer.lock", "Gemfile.lock", "Pipfile.lock", "poetry.lock",
  "pdm.lock", "uv.lock", "Package.resolved", "packages.lock.json", "gradle.lockfile", "flake.lock",
  "MODULE.bazel.lock", ".terraform.lock.hcl", "Manifest.toml", "JuliaManifest.toml", "pixi.lock",
]);

const EXCLUDED_DIRECTORY_NAMES = new Set([
  "node_modules", "bower_components", "vendor", "vendors", "third_party", "third-party", "3rdparty",
  "Pods", "__generated__", "generated-sources", "__snapshots__", "dist", "build", "out", "target", "obj",
  "coverage", "htmlcov", "lcov-report", ".nyc_output",
  ".next", ".nuxt", ".svelte-kit", "_build", "_site", "bazel-out", ".openapi-generator",
]);

function classificationPath(path: string, projectRoot: string): string {
  const resolvedPath = isAbsolute(path) ? resolve(path) : resolve(projectRoot || ".", path);
  if (projectRoot) {
    const rel = relative(resolve(projectRoot), resolvedPath);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return normalizePath(rel || ".");
  }
  return normalizePath(resolvedPath);
}

function hasExcludedPath(path: string, projectRoot: string): boolean {
  const normalized = classificationPath(path, projectRoot);
  const file = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (EXCLUDED_BASENAMES.has(file)) return true;
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => EXCLUDED_DIRECTORY_NAMES.has(segment))) return true;
  if (/(?:^|\/)Carthage\/Build\//.test(normalized) || /(?:^|\/)\.yarn\/(?:cache|unplugged)\//.test(normalized)) return true;
  if (/(?:^|\/)gradle\/dependency-locks\/[^/]+\.lockfile$/.test(normalized)) return true;
  if (/(?:^|\/)db\/(?:schema\.rb|structure\.sql)$/.test(normalized)) return true;
  return /(?:\.min\.(?:js|css)|-min\.(?:js|css)|\.(?:bundle|chunk)\.(?:js|css)|\.(?:js|css)\.map|\.snap(?:\.new)?|\.designer\.(?:cs|vb)|\.feature\.cs|\.pb\.go|_grpc\.pb\.go|_pb2\.py|_pb2_grpc\.py|\.pb\.(?:cc|h|dart)|\.grpc\.pb\.(?:cc|h)|\.generated\.[^/]+|\.g\.cs|\.g\.i\.cs)$/.test(file);
}

function isComment(line: string): boolean {
  return /^(?:\/\/|\/\*|\*|#|<!--|--|;)/.test(line.trim());
}

function hasGeneratedMarker(path: string, content: string): boolean {
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const allLines = normalized.split("\n");
  const header = allLines.slice(0, 40);
  if (header.some((line) => /^\/\/ Code generated .* DO NOT EDIT\.$/.test(line))) return true;

  const generated = /(?:code generated|generated code|auto-generated|autogenerated|this file is generated)/i;
  const noManualEdit = /(?:do not edit|do not modify|not intended for manual editing)/i;
  for (let index = 0; index < header.length; index++) {
    if (!isComment(header[index] ?? "")) continue;
    const pair = [header[index - 1], header[index], header[index + 1]].filter((line): line is string => typeof line === "string" && isComment(line));
    if (pair.some((line) => generated.test(line)) && pair.some((line) => noManualEdit.test(line))) return true;
  }

  const lowerPath = path.toLowerCase();
  const toolHeader = /(?:Generated by the protocol buffer compiler|Generated by (?:the )?gRPC|Autogenerated by Thrift Compiler|Generated by Cython|Generated by jOOQ|generated by JFlex|Generated by roxygen2)/i;
  const generatedCodeSuffix = /\.(?:c|cc|cpp|cxx|h|hpp|cs|dart|go|java|js|kt|kts|m|mm|php|py|r|rb|rs|scala|swift|ts)$/;
  if (generatedCodeSuffix.test(lowerPath) && header.some((line) => isComment(line) && toolHeader.test(line))) return true;

  if (lowerPath.endsWith(".java") && header.some((line) => /^\s*@(?:(?:javax|jakarta)\.annotation(?:\.processing)?\.)?Generated\s*\(/.test(line))) return true;
  if (/\.(?:cs|vb)$/.test(lowerPath) && header.some((line) => /^\s*(?:\[|<)\s*(?:(?:global::|Global\.)?System\.CodeDom\.Compiler\.)?GeneratedCode(?:Attribute)?\s*\(/i.test(line))) return true;

  if (/\.(?:js|css)$/.test(lowerPath)) {
    const physicalLines = allLines.at(-1) === "" ? allLines.slice(0, -1) : allLines;
    const trailer = physicalLines.slice(-2);
    if (trailer.some((line) => /^\s*(?:\/\/[#@]|\/\*[#@])\s*sourceMappingURL=/.test(line))) return true;
  }

  if (lowerPath.endsWith(".map") && !lowerPath.endsWith(".js.map") && !lowerPath.endsWith(".css.map")) {
    try {
      const value = JSON.parse(normalized) as Record<string, unknown>;
      if (value.version === 3 && Array.isArray(value.sources) && value.sources.every((source) => typeof source === "string") && typeof value.mappings === "string") return true;
    } catch {
      // Unknown .map text remains eligible.
    }
  }
  return false;
}

function looksBinary(content: string): boolean {
  return content.includes("\0");
}

export function isEligible(path: string, content: string, policy: SessionPolicy): boolean {
  if (matchesExplicit(path, policy.include, policy.projectRoot)) return true;
  if (matchesExplicit(path, policy.exclude, policy.projectRoot)) return false;
  if (looksBinary(content)) return false;
  if (hasExcludedPath(path, policy.projectRoot)) return false;
  if (hasGeneratedMarker(path, content)) return false;
  return true;
}

export function evaluateMutation(mutation: ObservedMutation): string | undefined {
  const { path, before, after, policy } = mutation;
  if (!isEligible(path, after, policy)) return undefined;
  if (before !== undefined && looksBinary(before) && !matchesExplicit(path, policy.include, policy.projectRoot)) return undefined;

  const afterLines = countPhysicalLines(after);
  if (afterLines <= policy.maxLines) return undefined;
  if (before === undefined) return formatNudge(afterLines, policy.maxLines);

  const beforeLines = countPhysicalLines(before);
  const netGrowth = afterLines - beforeLines;
  if (beforeLines <= policy.maxLines) return formatNudge(afterLines, policy.maxLines, netGrowth);
  if (netGrowth >= policy.significantGrowthLines) return formatNudge(afterLines, policy.maxLines, netGrowth);
  return undefined;
}
