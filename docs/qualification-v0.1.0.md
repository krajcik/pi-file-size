# v0.1.0 release-candidate qualification

Date: 2026-08-07

## Scope

This record qualifies the locally prepared `pi-file-size` v0.1.0 release candidate. It does not claim npm publication, registry availability, or model-benchmark performance. Model pairwise screening was removed from PI-6 by explicit user decision.

No global Pi installation, package publication, deployment, or remote write was performed.

## Selected champion

- Source decision commit: `762276c`
- Default soft maximum: `maxLines = 1000`
- Significant-growth threshold: `150` physical lines (unchanged)
- Nudge wording:

> Size nudge: this eligible file is now {afterLines} physical lines (soft maximum {maxLines}[; net growth +{netGrowth}]). Before adding more here, look for a cohesive part of the new behavior that can be safely extracted behind a clear local boundary. If none exists, leave the file intact; do not split by line count or refactor unrelated legacy code.

The state machine, classifier, configuration contract, and silent behavior remain unchanged.

## Environment

- macOS
- Node.js `26.6.0`
- npm `11.18.0`
- Pi `0.84.1`

Linux and Windows were not independently qualified for this candidate.

## Deterministic checks

The following commands completed successfully from the repository root:

```bash
npm test
npm run validate:package
npm run check
node benchmark/smoke.mjs /tmp/pi-file-size-v0.1.0-qualification/smoke-report.json
```

Results:

- `npm test`: 46 tests passed.
- `npm run validate:package`: 9 intended package files, zero runtime dependencies.
- `npm run check`: syntax checks, 46 tests, and package validation passed.
- Offline harness smoke: four deterministic pairs were judged; all hard gates passed. This exercises harness/package integration with fake adapters and is not model-performance evidence.

Evidence SHA-256:

- `npm-test.log`: `f31f35dc2a94d9d0ee28dac8201911245e9cc8f6566074946e92891d4b86156c`
- `validate-package.log`: `54032ad986cb02ad347d35e78b37e60f6b122ba63f14c25dbc78c3e37759122e`
- `check.log`: `285908813660cbd2b7d89389e85620911cd6ea29d80d79985b3d27da4560f42a`
- `smoke-report.json`: `a9eb66092e290030901190c19d8cd3036ff8d0e571ff14a2910a706f73057469`

Raw evidence is stored locally under `/tmp/pi-file-size-v0.1.0-qualification`; it is not part of the package.

## Ephemeral Pi loading

The extension loaded successfully in an isolated temporary working directory and `HOME`, with networking, sessions, context files, approval prompts, and implicit extensions disabled. Standard input was empty, so no model request was made:

```bash
HOME="$temporary_home" PI_OFFLINE=1 pi \
  --offline \
  --mode json \
  --no-session \
  --no-context-files \
  --no-approve \
  --no-extensions \
  --extension /absolute/path/to/pi-file-size/extensions/size-nudge.ts \
  </dev/null
```

The command exited `0`, emitted one Pi session-v3 JSON event, and emitted no stderr. The normalized event SHA-256 is `245bd659d4a008f8ef01827a436fc0095651fa43af8fcd2b9c8d2baae906130f`.

## Package artifact

The local artifact was created without lifecycle scripts:

```bash
npm pack --json --ignore-scripts --pack-destination /tmp/pi-file-size-v0.1.0-qualification
```

- Artifact: `pi-file-size-0.1.0.tgz`
- Size: 12,990 bytes compressed; 39,393 bytes unpacked
- Files: 9
- SHA-256: `67a89130f613c5443e2f0c29aa2339071694655124c18728daae8c1c4e3d5c12`
- npm SHA-1: `ab7ba55aba93ec6b5298c808ab8930cc564cb398`
- npm integrity: `sha512-1yp49iUiGpfyCAwYSBOK5RrXs+aVhgBJzProKKXD6GVRxJevudYldklND9VatzurbiPE3SqdS0jGtbyc8lTO1g==`

Contents:

```text
CHANGELOG.md
LICENSE
README.md
extensions/size-nudge.ts
package.json
src/config.ts
src/edit-semantics.ts
src/policy.ts
src/runtime.ts
```

The tarball remains a local qualification artifact and was not published.

## Independent review

An independent standards/spec review found no high- or medium-severity release blockers. It verified the champion and wording, stored evidence hashes, tarball bytes and metadata, ephemeral-load evidence, version/license/platform statements, and absence of model-performance or publication claims.

Residual risks are limited to the documented unqualified platforms and Pi versions, lack of an OS-level network trace, and the locally stored rather than repository-embedded command transcripts.

## Approval-gated follow-up

A global local-package installation and longer dogfood session were not performed. They require separate explicit approval because they modify user-level Pi settings. Publication and release creation likewise require separate approval.
