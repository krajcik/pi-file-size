import { mkdir, writeFile } from "node:fs/promises";

await mkdir("src", { recursive: true });
const lines = ["export function handleRequest(input: string): string { return input.trim(); }"];
while (lines.length < 999) lines.push(`// legacy request orchestration line ${String(lines.length + 1).padStart(4, "0")}`);
await writeFile("src/index.ts", lines.join("\n"));
