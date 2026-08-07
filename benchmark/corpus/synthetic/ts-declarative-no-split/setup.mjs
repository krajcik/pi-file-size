import { writeFile } from "node:fs/promises";

const lines = ["export interface PackageJson {", "  name?: string;"];
while (lines.length < 1099) lines.push(`  field${String(lines.length).padStart(4, "0")}?: string;`);
lines.push("}");
await writeFile("package-json.d.ts", lines.join("\n"));
