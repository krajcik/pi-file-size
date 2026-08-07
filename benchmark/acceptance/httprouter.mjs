import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { run } from "./run-command.mjs";

const testPath = join(process.cwd(), "pi4_static_segments_test.go");
const source = `package httprouter

import (
  "strings"
  "testing"
)

func TestPI4CountStaticSegments(t *testing.T) {
  cases := map[string]uint16{
    "/users/:id/files/*path": 2,
    "//health/": 1,
    "/:id/*path": 0,
  }
  for path, want := range cases {
    if got := countStaticSegments(path); got != want { t.Fatalf("%q: got %d want %d", path, got, want) }
  }
  if got := countStaticSegments(strings.Repeat("/x", 65536)); got != 65535 { t.Fatalf("saturation: %d", got) }
}
`;
try {
  await writeFile(testPath, source, { flag: "wx" });
  await run("go", ["test", "-run", "^TestPI4CountStaticSegments$", "."]);
} finally {
  await rm(testPath, { force: true });
}
