# pi-file-size

`pi-file-size` gives Pi coding agents a size nudge when their own successful `edit` or `write` makes an eligible text file suspiciously large. It never blocks the change. It asks the agent to extract new behavior only when that behavior has a clear local boundary.

`pi-file-size` is published on [npm](https://www.npmjs.com/package/pi-file-size) and source releases are available on [GitHub](https://github.com/krajcik/pi-file-size/releases).

## The problem

A coding agent usually takes the shortest safe path to finish the current change. If related code is already in an open file, the agent tends to keep adding there. Repeated edits can turn one file into a mix of unrelated responsibilities that is harder to navigate, review, and test.

A hard line-count limit creates a different problem. It can block a necessary fix, punish a small edit to an old large file, or push the agent into arbitrary file splitting. Constant warnings are easy to ignore and consume model context even when no useful refactor exists.

This extension intervenes only after an attributable mutation crosses the configured soft maximum or adds substantial growth to a file that was already over it. The nudge reports the measured size and asks for a cohesive extraction. It also says to leave the file intact when no safe boundary exists.

## Behavior

The default soft maximum is **1,000 physical lines** and the default significant-growth threshold is **150 net physical lines**. A nudge is appended to the successful tool result in exactly three cases:

1. A newly written eligible file has more than `maxLines` lines.
2. An existing eligible file crosses from at or below `maxLines` to above it (a first crossing).
3. A file that was already above `maxLines` remains above it and grows by at least `significantGrowthLines` net lines.

Physical lines include code, comments, and blank lines. An empty file has zero lines; a final newline terminates the last line but does not create an additional line. LF, CRLF, and CR line endings are supported, and an initial UTF-8 BOM is not itself a line.

The extension is silent when a file is at or below the maximum, when an already-oversized file shrinks or grows by less than the significant-growth threshold, or when the file is ineligible. It is also silent for failed tools, reads, custom or overridden `edit`/`write` tools, unsupported or unattributable filesystem changes, ambiguous concurrent mutations, non-regular files, and before-state that cannot be read as UTF-8. Silence adds no model-context overhead.

A triggering nudge is event-local text appended to the tool result that caused it, so the agent sees that nudge in normal tool-result context. The extension does not add permanent prompt instructions, hidden messages, custom tools, or messages on silent work.

## Configuration

For a trusted project, place configuration at `.pi/size-nudge.json` beneath the Pi session working directory:

```json
{
  "maxLines": 1200,
  "significantGrowthLines": 200,
  "include": ["vendor/first-party/**"],
  "exclude": ["generated-local/**", "**/*.fixture.ts"]
}
```

All fields are optional, but no other fields are accepted:

| Field | Default | Meaning |
| --- | --- | --- |
| `maxLines` | `1000` | Non-negative integer soft maximum. A file is oversized only when its count is greater than this value. |
| `significantGrowthLines` | `150` | Positive integer minimum net growth for a file that was already oversized. |
| `include` | `[]` | Array of non-empty, case-sensitive path globs that force eligibility. |
| `exclude` | `[]` | Array of non-empty, case-sensitive path globs that make matching files ineligible. |

Patterns use `/` separators; `*` and `?` stay within one path segment, while `**` crosses segments. Matching considers the absolute path, basename, and—when the file is inside the project—the project-relative path. For a path outside the working directory, use an absolute pattern or basename pattern.

**Explicit `include` has highest precedence.** It wins over `exclude`, binary detection, and every built-in name, path, and generated-content rule. Explicit `exclude` is checked next, before built-ins.

Configuration is loaded once for the extension runtime/session policy. The initiating session's one policy governs observed paths both inside and outside its working directory; configuration is never discovered beside an outside file. Untrusted projects do not have `.pi/size-nudge.json` read and use defaults without a warning. In a trusted project, missing configuration also quietly uses defaults. Malformed JSON, unknown fields, or any invalid field causes the entire configuration to be rejected atomically: all defaults are used and one warning is reported through Pi's UI, or to standard error in headless mode. That warning is not inserted into the session or model context.

## Built-in eligibility policy

Unless force-included, content containing a NUL is treated as binary. The following high-confidence mechanical artifacts are excluded:

- Lock/resolver basenames: `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock`, `bun.lockb`, `deno.lock`, `Cargo.lock`, `go.sum`, `composer.lock`, `Gemfile.lock`, `Pipfile.lock`, `poetry.lock`, `pdm.lock`, `uv.lock`, `Package.resolved`, `packages.lock.json`, `gradle.lockfile`, `flake.lock`, `MODULE.bazel.lock`, `.terraform.lock.hcl`, `Manifest.toml`, `JuliaManifest.toml`, and `pixi.lock`.
- Dependency/output directories: `node_modules`, `bower_components`, `vendor`, `vendors`, `third_party`, `third-party`, `3rdparty`, `Pods`, `__generated__`, `generated-sources`, `__snapshots__`, `dist`, `build`, `out`, `target`, `obj`, `coverage`, `htmlcov`, `lcov-report`, `.nyc_output`, `.next`, `.nuxt`, `.svelte-kit`, `_build`, `_site`, `bazel-out`, and `.openapi-generator`; also `Carthage/Build`, `.yarn/cache`, `.yarn/unplugged`, and `gradle/dependency-locks/*.lockfile`.
- Narrow generated names: minified/bundle/chunk JS or CSS, JS/CSS source maps, snapshots, common designer/Protobuf/gRPC/generated-code suffixes, and Rails `db/schema.rb` or `db/structure.sql` dumps.
- Generated content signatures in the first 40 lines: the exact Go generated marker, paired generated/do-not-edit comments, selected tool headers on code files, and Java/.NET generated annotations. A JS/CSS `sourceMappingURL` in the final two physical lines and structurally valid version-3 source-map JSON are also excluded.

Unknown text remains eligible. Documentation, migrations, source schemas, declarative data/configuration, generic fixtures/testdata, ordinary `.d.ts`, arbitrary `.lock`/`.map` files, and `deps`, `external`, or `golden` directories are not excluded merely by category.

## Compatibility and support

The extension has been tested on macOS with Node.js `26.6.0` and Pi `0.84.1`. It uses Pi's public extension API and Node.js filesystem APIs and is expected to work in other local environments supported by Pi, but Linux and Windows have not been independently tested. The package is for the Pi coding agent runtime, not browsers.

The Pi peer range remains `*` by package convention. Compatibility has been verified specifically against Pi `0.84.1`; the range is not a claim that every historical or future Pi version is supported.

## Installation and local testing

Review the source first. To try the published package for one run without changing Pi settings:

```bash
pi -e npm:pi-file-size@0.1.1
```

To install the published version in user settings:

```bash
pi install npm:pi-file-size@0.1.1
```

To try this checkout directly, load its extension file for one run:

```bash
pi -e /absolute/path/to/pi-file-size/extensions/size-nudge.ts
```

To load the checkout as a local Pi package, use an absolute or relative package path:

```bash
# User settings (~/.pi/agent/settings.json)
pi install /absolute/path/to/pi-file-size

# Project settings (.pi/settings.json)
pi install ./relative/path/to/pi-file-size -l
```

Local paths are referenced in place rather than copied. Project-local packages load only after project trust.

Run deterministic repository checks without installing dependencies:

```bash
npm test
npm run check
npm run validate:package
```

The package validator performs `npm pack --dry-run --json --ignore-scripts`, checks the exact publish file set and metadata, and scans runtime imports for network/telemetry use.

## Security, privacy, and limitations

Pi extensions execute arbitrary code with the user's full system permissions. Install or load this extension only from source you trust. This extension reads trusted-project configuration and pre-mutation file content needed for attribution. It has zero runtime dependencies and contains no telemetry, runtime network access, background sockets/processes, or runtime network imports. It does not call Pi message-injection or session-persistence APIs; only a triggering tool result is extended as described above.

The implementation uses Pi's documented extension events and public built-in tool source metadata.

Current limitations are intentionally conservative:

- Only successful, attributable Pi built-in `edit` and `write` mutations are observed. Changes from shell commands, custom tools, other processes, or failed/ambiguous observations are not inferred.
- Generated and vendored detection is a static, high-confidence heuristic, not a complete ecosystem classifier. It can miss custom output paths; conventional directory names can also classify hand-written files unless force-included.
- Glob matching is a small documented subset, is case-sensitive on every platform, and does not read `.gitattributes` or Git ignore rules.
- Files must be regular files with valid UTF-8 before-state. Observation errors fail open: Pi's tool behavior is never blocked or changed, but no nudge is produced.
- Conservative attribution suppresses nudges when unsupported parallel work or same-file aliases make causality uncertain.

## License

MIT. See [LICENSE](LICENSE).
