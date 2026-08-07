import { spawn } from "node:child_process";

export function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: process.cwd(), env: process.env, shell: false, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${executable} acceptance command exited ${code ?? signal}`));
    });
  });
}
