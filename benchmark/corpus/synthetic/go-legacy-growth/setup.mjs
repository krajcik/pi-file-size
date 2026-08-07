import { writeFile } from "node:fs/promises";

const lines = ["package legacy", "", "type Server struct{}", "", "func (Server) Health() string { return \"ok\" }"];
while (lines.length < 1050) lines.push(`// stable legacy handler line ${String(lines.length + 1).padStart(4, "0")}`);
await writeFile("server.go", lines.join("\n"));
