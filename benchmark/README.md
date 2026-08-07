# PI-4 pairwise benchmark

This directory is an offline-capable, dependency-free benchmark harness for comparing the `pi-file-size` extension with a no-extension baseline. It is benchmark infrastructure only and is excluded from the npm package.

## Design

A run has exactly two distinct model/executor family IDs. Each family executes both candidate and baseline in fresh workspaces; the resulting pair is judged by the *other* family. A seeded PRNG chooses artifact order.

The harness snapshots each generated or checked-out workspace before execution and again afterward. It creates a deterministic normalized artifact containing every modified, added, deleted, or untracked file (excluding checkout-only `.git` metadata). Text is newline-normalized, binary content is base64, paths are workspace-relative, and entries are sorted. Judge requests contain only blind task context and artifacts labeled `A`/`B`. They contain no executor answer, family, variant, revision, extension metadata, treatment name, or temporary path. Executor answers remain report-only audit fields and are never used for semantic judging. Identical normalized artifacts are tied automatically before a judge is called; judge runtime and tokens remain `null` and the record states the automatic-tie reason.

The judge rubric is ordered deliberately:

1. cohesion;
2. scope safety;
3. useful size reduction.

Numeric file chopping and unrelated refactoring are explicit penalties. A tie contributes `0.5` to candidate score and pairwise win rate.

After each trajectory, the harness independently runs the manifest upstream check and, for OSS tasks, a benchmark-owned acceptance check. Both statuses/details are recorded and either can hard-fail the pair. Synthetic checks compare controlled output with exact permitted direct/extracted transformations rather than trusting text matches or requiring Go/Python. Executor self-reports are ignored. Commands have timeouts and 1 MiB stdout/stderr caps and are spawned directly without a shell. Subprocess bytes are decoded only after close. Workspace capture uses a preflight inventory and is bounded to 5,000 files, 1,000 directories, 6,000 total entries, depth 32, 2 MiB per file, and 32 MiB aggregate before file contents are read. Traversal and bounded chunk reads honor run cancellation. On supported POSIX systems, timeout, output overflow, SIGINT, or SIGTERM kills active process groups, awaits close, and then removes temporary workspaces. Windows cancellation/process-group semantics are outside this benchmark release contract.

## Corpus and execution safety

`corpus.json` is the frozen 10-task manifest: five controlled synthetic tasks and five permissively licensed public OSS revisions pinned to full 40-character commits. Every task has concrete acceptance examples for blind semantic judging. Coverage includes TypeScript, Go, Python, first crossing, significant and legacy growth, separable growth, false-positive pressure, and cohesive/declarative no-extraction.

Synthetic fixtures store compact setup generators rather than thousand-line source files. Setup runs before the pre-execution snapshot and materializes exact threshold cases: a 999-line TypeScript file crosses through only the requested formatter/export, a 1,000-line registry crosses through only the requested entry, and already-oversized Go files gain requested explicit 150-entry audit/priority tables. No benchmark padding is part of a requested mutation. The declarative small-growth case remains silent at the real 1,000-line maximum and 150-line significant-growth defaults. The smoke loads the actual extension module on a MockPi event surface, performs an attributable built-in write, observes the real event-local size nudge, and makes its deterministic follow-up from that signal. It invokes no model and needs no network.

OSS workspaces are fetched only when an OSS task is explicitly selected for a real run. Such runs require `git`, repository access, and pre-provisioned Go, Python/pytest, or npm/TypeScript tooling and project dependencies. The harness does not install dependencies. The upstream suite remains a regression gate. A checked-in Node wrapper then creates an isolated task-specific acceptance test, invokes the pre-provisioned project toolchain, and removes that test in `finally`; the blind cross-family judge evaluates implementation quality only after both gates pass.

**Checks execute code from the pinned workspace.** Their environment is scrubbed to an essential platform/locale/toolchain-root allowlist and uses isolated `HOME`, temporary, `GOPATH`, and `GOCACHE` directories. Host `PYTHONPATH`, `NODE_PATH`, `GOPATH`, and `GOCACHE` are not inherited. This is not a sandbox: filesystem/process access remains possible, and the harness does not provide network isolation. Review pinned revisions and check commands as code before running them. Executor and judge adapters intentionally inherit the operator environment because real model wrappers may require credentials; judge payload blindness does not imply process-level credential isolation.

The OSS tasks are controlled benchmark descriptors, not claims that upstream requested the changes. Change a task only by intentionally updating its frozen revision/descriptor.

## Adapter protocol

Executor and judge commands are JSON command arrays, for example:

```json
["my-model-wrapper", "--model", "family-a"]
```

Each command receives one JSON object on stdin and emits one JSON object on stdout. Diagnostics belong on stderr.

Executor requests contain only protocol version, opaque absolute workspace, task/task revision, and candidate `{path, sourcePaths, config, sourceSha256, configSha256, effectiveSha256}` extension metadata or explicit `null` for baseline. Family and variant identity/revision are determined by command configuration and are not sent.

The wrapper runs its agent in `workspace` and loads the specified extension/config. It returns a non-empty `answer` for audit and may return `tokenUsage` as non-negative safe-integer `input`/`output` fields plus optional `cached`; omitted usage is recorded as explicit `null`. Optional `observedSignal` must be bounded JSON-safe data. Judge token usage uses the same schema. The harness, not the wrapper, captures the judged artifact.

Before judging, the harness rejects UTF-8 or binary artifact content containing known treatment-only IDs/revisions, source/config/effective digests, normalized source paths, canonical full config serialization, or absolute run/extension source paths; it does not silently redact those values. This boundary catches direct accidental/malicious disclosure tested by the harness, but it is not protection against arbitrary covert channels or semantically encoded treatment hints. A judge request has exactly blind `task` metadata (including the ordered rubric) and `artifacts` labeled `A`/`B`. It returns:

```json
{"verdict":"A|B|tie","rationale":"optional","tokenUsage":{"input":123,"output":45}}
```

## Configuration and running

See `smoke.config.json` for the complete schema. Required fields are `seed`, `repetitions`, a non-empty unique `tasks` list, exactly two `families`, both variants, and `output`. Candidate must provide an existing extension entrypoint, a non-empty `sourcePaths` array, and effective config; baseline extension must be `null`. Source paths resolve relative to the config, must include the entrypoint, and are recorded as normalized config-relative paths. The stable source digest hashes sorted normalized paths plus file bytes, so it covers the entrypoint and its declared local runtime sources. Optional candidate `sourceSha256` pins that bundle and is rejected on initial or per-trajectory mismatch. The harness also records canonical config, config digest, and combined effective digest. Optional timeout and corpus paths resolve relative to the config file.

Run the fixed-seed synthetic smoke:

```bash
npm run benchmark:smoke
# or retain the report at a chosen path
node benchmark/smoke.mjs /tmp/pi-file-size-pairwise.json
```

Without an argument, output is written under the operating-system temporary directory. The complete machine-readable report is emitted as one JSON line on stdout and its path on stderr.

Run another configuration directly:

```bash
node benchmark/harness.mjs --config benchmark/smoke.config.json --output /tmp/report.json
```

Records include task/variant revisions, a stable SHA-256 of the full frozen task descriptor, normalized extension source paths and source/config/effective digests, seeded order, executor/judge roles, verdict, runtimes, explicit nullable token usage, normalized artifacts/digests, observed audit signals, artifact-leak results, and independently attributed upstream/acceptance exit, spawn, or timeout details. Global and per-executor-family summaries report wins, losses, ties, score, rate, and gate status. Global `pairwiseWinRate` is `(candidateWins + 0.5 * ties) / judgedPairs`.
