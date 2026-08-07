# File Size Guidance

This context defines the language for guiding coding agents away from oversized source files without turning file size into a rigid enforcement rule.

## Language

**Size nudge**:
A rare, non-blocking recommendation shown to a coding agent when its change creates a suspiciously large file or substantially grows one. It must not penalize small changes to already-large files.
_Avoid_: Limit, violation, enforcement, gate

**Observed mutation**:
A successful file change that the product can attribute to one agent action and compare before and after. Unattributed filesystem changes are outside the product contract.
_Avoid_: Any file change, repository change

**Eligible file**:
A text file subject to size guidance after an observed mutation. Generated, vendored, locked, minified, snapshot, and other mechanically large artifacts are excluded by policy.
_Avoid_: Source file, every text file

**Physical lines**:
The file-size metric used by the product: every line in the text counts, including blank and comment-only lines. An empty file has zero physical lines.
_Avoid_: SLOC, logical lines, token count

**Oversized file**:
An eligible file whose physical-line count exceeds the configured soft maximum. Being oversized is advisory state, not a violation.
_Avoid_: Invalid file, forbidden file

**First crossing**:
An observed mutation that moves an existing eligible file from at or below the soft maximum to above it.
_Avoid_: Legacy growth

**Significant growth**:
An observed mutation whose after-minus-before physical-line count is large enough to justify a size nudge for an already-oversized eligible file. Gross diff churn, small net growth, and any reduction are not significant growth.
_Avoid_: Any growth, threshold crossing

**Cohesive extraction**:
A local restructuring that moves newly added, independently understandable behavior behind a clear boundary without scattering one concept or refactoring unrelated legacy code.
_Avoid_: Split, file chopping, compliance refactor

**Session policy**:
The single size-guidance policy active for a working session. It governs every observed mutation regardless of file location; policy is not rediscovered beside external files.
_Avoid_: Nearest-file policy, repository-only policy

**Generated artifact**:
An eligible-looking text file made ineligible by a known generated name or path, a bounded generated-file marker, or an explicit session-policy exclusion. Unknown files remain eligible rather than being guessed as generated.
_Avoid_: Any ignored file, any declarative file
