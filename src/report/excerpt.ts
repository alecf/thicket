export interface ExcerptOptions {
  /** Lines to show before eliding the rest. */
  maxLines: number;
  /** Width to truncate each line to, including the ellipsis. */
  maxColumns: number;
}

/** Marks that the fragment continues past what is shown. */
const ELLIPSIS = "…";

/**
 * A few lines of the source a finding points at.
 *
 * The report named every finding by AST kind alone — `PropertyAssignment`,
 * `Block` — which tells a reader nothing about whether it is worth acting on.
 * Deciding meant opening files, and a cluster can span a hundred of them. For
 * an LLM consuming the report inside a refactoring loop this is the highest
 * value per token in the whole document: three lines are usually enough to
 * tell a genuine missing abstraction from two things that merely share a
 * shape.
 */
export function excerptOf(
  text: string,
  start: number,
  end: number,
  opts: ExcerptOptions,
): string[] {
  const slice = text.slice(start, end);
  if (slice.trim() === "") return [];

  const all = slice.split("\n");
  const shown = all.slice(0, opts.maxLines);
  const elided = all.length > shown.length;

  // Dedent by the CONTINUATION lines. A fragment often starts mid-line -- an
  // object literal inside a call, the condition of an `if` -- so its first
  // line carries no indentation and is already flush; including it would make
  // the minimum zero and leave every excerpt at whatever depth it sat.
  //
  // Measured over ALL the fragment's lines rather than the shown ones, so the
  // indentation a reader sees does not shift when `maxLines` happens to cut
  // above the closing brace.
  let indent = Number.POSITIVE_INFINITY;
  for (const line of all.slice(1)) {
    if (line.trim() === "") continue;
    indent = Math.min(indent, line.length - line.trimStart().length);
  }
  if (!Number.isFinite(indent)) indent = 0;

  const out = shown.map((line, i) => {
    const dedented = i === 0 ? line.trimStart() : line.slice(indent);
    return truncate(dedented.trimEnd(), opts.maxColumns);
  });
  if (elided) out.push(ELLIPSIS);
  return out;
}

/** Hard cap on width, so a minified or generated line cannot flood the report. */
function truncate(line: string, maxColumns: number): string {
  if (line.length <= maxColumns) return line;
  return line.slice(0, maxColumns - ELLIPSIS.length) + ELLIPSIS;
}
