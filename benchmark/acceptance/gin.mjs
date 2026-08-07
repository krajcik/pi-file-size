import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { run } from "./run-command.mjs";

const testPath = join(process.cwd(), "pi4_get_header_values_test.go");
const source = `package gin

import (
  "net/http/httptest"
  "reflect"
  "testing"
)

func TestPI4GetHeaderValues(t *testing.T) {
  empty := &Context{}
  if got := empty.GetHeaderValues("X-Tag"); got != nil { t.Fatalf("nil Request: %#v", got) }
  request := httptest.NewRequest("GET", "/", nil)
  request.Header.Add("X-Tag", "first")
  request.Header.Add("x-tag", "second")
  context := &Context{Request: request}
  if got := context.GetHeaderValues("X-TAG"); !reflect.DeepEqual(got, []string{"first", "second"}) { t.Fatalf("values: %#v", got) }
}
`;
try {
  await writeFile(testPath, source, { flag: "wx" });
  await run("go", ["test", "-run", "^TestPI4GetHeaderValues$", "."]);
} finally {
  await rm(testPath, { force: true });
}
