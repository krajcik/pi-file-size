import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

const pidPath = process.argv[2];
let input = "";
for await (const chunk of process.stdin) input += chunk;
JSON.parse(input);
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
await writeFile(pidPath, String(descendant.pid));
setInterval(() => {}, 1000);
