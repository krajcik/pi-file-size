import { writeFile } from "node:fs/promises";

const lines = ["COMMANDS = {", "    \"alpha\": \"Create an item\","];
while (lines.length < 999) lines.push(`    \"command_${String(lines.length).padStart(4, "0")}\": \"Stable command\",`);
lines.push("}");
await writeFile("registry.py", lines.join("\n"));
