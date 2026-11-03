// A text import, so `bun build` inlines the guide into the binary and the npm
// bundle alike. Reading it from disk at run time would fail in both: inside a
// compiled binary `import.meta.url` is a virtual path (AGENTS.md §7). Vitest
// gets the same import through the `text-md` plugin in `vitest.config.ts`.
import guide from "../../docs/report-guide.md" with { type: "text" };

/**
 * The guide section that asks the reading agent to file issues against
 * thicket. It is the last section of the guide, so a private copy is the
 * guide cut off at this heading. `tests/guide.test.ts` holds it there.
 */
export const FEEDBACK_HEADING = "## Reporting a bad finding to thicket";

/**
 * The field guide, for `--embed`. A private copy leaves out the feedback
 * section. An agent cannot act on an instruction it never reads.
 */
export function guideText(opts: { private: boolean }, source: string = guide): string {
  // A Windows checkout with core.autocrlf holds the guide with CRLF. The cut
  // below keys on "\n", and the report must be byte-identical across hosts.
  const text = source.replaceAll("\r\n", "\n");
  if (!opts.private) return text;
  const at = text.indexOf(`\n${FEEDBACK_HEADING}\n`);
  if (at === -1) throw new Error(`report guide has no "${FEEDBACK_HEADING}" section`);
  // The section opens after a `---` rule. Drop the rule with it.
  return text.slice(0, at).replace(/\n+---\n*$/, "") + "\n";
}
