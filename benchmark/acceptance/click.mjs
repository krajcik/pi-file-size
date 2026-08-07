import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { run } from "./run-command.mjs";

const testPath = join(process.cwd(), "tests", "test_pi4_parameter_by_name.py");
const source = `from click.core import Command, Option


def test_pi4_get_parameter_by_name():
    first = Option(["--alpha"])
    beta = Option(["--beta"])
    duplicate = Option(["--alpha"])
    command = Command("example", params=[first, beta, duplicate])
    assert command.get_parameter_by_name("beta") is beta
    assert command.get_parameter_by_name("missing") is None
    assert command.get_parameter_by_name("alpha") is first
`;
try {
  await writeFile(testPath, source, { flag: "wx" });
  await run("python3", ["-m", "pytest", testPath]);
} finally {
  await rm(testPath, { force: true });
}
