export interface Replacement {
  oldText: string;
  newText: string;
}

const normalizeLf = (text: string) => text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

function normalizeFuzzy(text: string): string {
  return text.normalize("NFKC")
    .split("\n").map((line) => line.trimEnd()).join("\n")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

function occurrences(content: string, text: string): number {
  const haystack = normalizeFuzzy(content);
  const needle = normalizeFuzzy(text);
  return haystack.split(needle).length - 1;
}

interface MatchedReplacement {
  index: number;
  length: number;
  newText: string;
}

function spans(content: string): Array<{ start: number; end: number }> {
  let offset = 0;
  return (content.match(/[^\n]*\n|[^\n]+/g) ?? []).map((line) => {
    const span = { start: offset, end: offset + line.length };
    offset = span.end;
    return span;
  });
}

function linesWithEndings(content: string): string[] {
  return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

function apply(content: string, replacements: MatchedReplacement[], offset = 0): string {
  let result = content;
  for (let index = replacements.length - 1; index >= 0; index--) {
    const replacement = replacements[index];
    const at = replacement.index - offset;
    result = result.slice(0, at) + replacement.newText + result.slice(at + replacement.length);
  }
  return result;
}

function applyFuzzyPreservingLines(original: string, base: string, replacements: MatchedReplacement[]): string | undefined {
  const originalLines = linesWithEndings(original);
  const baseSpans = spans(base);
  if (originalLines.length !== baseSpans.length) return undefined;
  const groups: Array<{ startLine: number; endLine: number; replacements: MatchedReplacement[] }> = [];
  for (const replacement of replacements) {
    const startLine = baseSpans.findIndex((span) => replacement.index >= span.start && replacement.index < span.end);
    if (startLine < 0) return undefined;
    let endLine = startLine;
    while (endLine < baseSpans.length && baseSpans[endLine].end < replacement.index + replacement.length) endLine++;
    if (endLine >= baseSpans.length) return undefined;
    const previous = groups.at(-1);
    if (previous && startLine < previous.endLine) {
      previous.endLine = Math.max(previous.endLine, endLine + 1);
      previous.replacements.push(replacement);
    } else {
      groups.push({ startLine, endLine: endLine + 1, replacements: [replacement] });
    }
  }
  let lineIndex = 0;
  let result = "";
  for (const group of groups) {
    result += originalLines.slice(lineIndex, group.startLine).join("");
    const start = baseSpans[group.startLine].start;
    const end = baseSpans[group.endLine - 1].end;
    result += apply(base.slice(start, end), group.replacements, start);
    lineIndex = group.endLine;
  }
  return result + originalLines.slice(lineIndex).join("");
}

export function applyBuiltInEdit(before: string, edits: Replacement[]): string | undefined {
  if (edits.length === 0) return undefined;
  const hasBom = before.startsWith("\uFEFF");
  const withoutBom = hasBom ? before.slice(1) : before;
  const ending = withoutBom.indexOf("\r\n") >= 0 && withoutBom.indexOf("\r\n") === withoutBom.indexOf("\n") - 1 ? "\r\n" : "\n";
  const original = normalizeLf(withoutBom);
  const normalizedEdits = edits.map((edit) => ({ oldText: normalizeLf(edit.oldText), newText: normalizeLf(edit.newText) }));
  if (normalizedEdits.some((edit) => edit.oldText.length === 0)) return undefined;

  const fuzzy = normalizedEdits.some((edit) => original.indexOf(edit.oldText) < 0 && normalizeFuzzy(original).indexOf(normalizeFuzzy(edit.oldText)) >= 0);
  const base = fuzzy ? normalizeFuzzy(original) : original;
  const matched: MatchedReplacement[] = [];
  for (const edit of normalizedEdits) {
    const exact = base.indexOf(edit.oldText);
    const needle = exact >= 0 ? edit.oldText : normalizeFuzzy(edit.oldText);
    const index = exact >= 0 ? exact : base.indexOf(needle);
    if (index < 0 || occurrences(base, edit.oldText) !== 1) return undefined;
    matched.push({ index, length: needle.length, newText: edit.newText });
  }
  matched.sort((left, right) => left.index - right.index);
  for (let index = 1; index < matched.length; index++) {
    if (matched[index - 1].index + matched[index - 1].length > matched[index].index) return undefined;
  }
  const next = fuzzy ? applyFuzzyPreservingLines(original, base, matched) : apply(base, matched);
  if (next === undefined || next === original) return undefined;
  const restored = ending === "\r\n" ? next.replace(/\n/g, "\r\n") : next;
  return (hasBom ? "\uFEFF" : "") + restored;
}
