import { writeFile } from "node:fs/promises";

const lines = ["package router", "", "type node struct { path string; children []*node }", "", "func (n *node) add(path string) { n.children = append(n.children, &node{path: path}) }"];
while (lines.length < 1001) lines.push(`// cohesive routing invariant ${String(lines.length + 1).padStart(4, "0")}`);
await writeFile("tree.go", lines.join("\n"));
