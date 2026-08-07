import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { run } from "./run-command.mjs";

const directory = join(process.cwd(), "test-d");
const testPath = join(directory, "pi4-publish-config-provenance.ts");
const source = `import {expectAssignable, expectNotAssignable} from 'tsd';
import type {PackageJson} from '../index';

expectAssignable<PackageJson.PublishConfig>({provenance: true});
expectAssignable<PackageJson.PublishConfig>({provenance: false});
expectNotAssignable<PackageJson.PublishConfig>({provenance: 'true'});
`;
try {
  await mkdir(directory, { recursive: true });
  await writeFile(testPath, source, { flag: "wx" });
  await run("npm", ["test"]);
} finally {
  await rm(testPath, { force: true });
}
