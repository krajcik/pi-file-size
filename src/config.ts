import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { DEFAULT_POLICY, type SessionPolicy } from "./policy.ts";

export const CONFIG_FILENAME = "size-nudge.json";
export const INVALID_CONFIG_WARNING = `Invalid ${CONFIG_FILENAME}; size nudges are using defaults for this session.`;

function defaults(projectRoot: string): SessionPolicy {
  return {
    maxLines: DEFAULT_POLICY.maxLines,
    significantGrowthLines: DEFAULT_POLICY.significantGrowthLines,
    include: [],
    exclude: [],
    projectRoot,
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

function parsePolicy(text: string, projectRoot: string): SessionPolicy {
  const value = JSON.parse(text) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("config must be an object");
  const record = value as Record<string, unknown>;
  const allowed = new Set(["maxLines", "significantGrowthLines", "include", "exclude"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new Error("unknown config field");
  if (record.maxLines !== undefined && (!Number.isInteger(record.maxLines) || (record.maxLines as number) < 0)) throw new Error("invalid maxLines");
  if (record.significantGrowthLines !== undefined && (!Number.isInteger(record.significantGrowthLines) || (record.significantGrowthLines as number) < 1)) throw new Error("invalid significantGrowthLines");
  if (record.include !== undefined && !isStringArray(record.include)) throw new Error("invalid include");
  if (record.exclude !== undefined && !isStringArray(record.exclude)) throw new Error("invalid exclude");
  return {
    maxLines: (record.maxLines as number | undefined) ?? DEFAULT_POLICY.maxLines,
    significantGrowthLines: (record.significantGrowthLines as number | undefined) ?? DEFAULT_POLICY.significantGrowthLines,
    include: [...((record.include as string[] | undefined) ?? [])],
    exclude: [...((record.exclude as string[] | undefined) ?? [])],
    projectRoot,
  };
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}

export async function loadSessionPolicy(
  projectRoot: string,
  trusted: boolean,
  warn: (message: string) => void,
  configDirName = ".pi",
): Promise<SessionPolicy> {
  const fallback = defaults(projectRoot);
  if (!trusted) return fallback;
  try {
    const text = await readFile(join(projectRoot, configDirName, CONFIG_FILENAME), "utf8");
    return parsePolicy(text, projectRoot);
  } catch (error) {
    if (isMissing(error)) return fallback;
    try {
      warn(INVALID_CONFIG_WARNING);
    } catch {
      // UI failures must not affect the session.
    }
    return fallback;
  }
}
