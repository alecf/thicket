import { compareStrings } from "../order.js";
import { stronglyConnected } from "./metrics.js";

/**
 * Whether anything in a module tangle is actually circular at the file level.
 *
 * A module SCC is a statement about directories, and directories are a choice
 * the tool made. Handed a 7-module SCC in a real application, an agent rebuilt
 * the import graph at file granularity and found three cycles in 417 files —
 * every one of them inside a single directory, none crossing any boundary the
 * finding drew. So nothing circular executes: there is no module-init hazard,
 * no bundler cycle, and the tangle is layering drift rather than a defect. That
 * one fact reversed its recommendation, it cost it a Tarjan implementation to
 * learn, and thicket had already built the graph it needed.
 *
 * The counts are kept apart because they mean opposite things. A cycle crossing
 * two of the component's modules is evidence FOR the finding. A cycle inside
 * one module is real but says nothing about this tangle — the grouping already
 * claims those files belong together.
 */
export interface FileCycles {
  /** File cycles spanning at least two of the component's modules. */
  crossing: CycleSummary;
  /** File cycles confined to a single module. */
  within: CycleSummary;
}

export interface CycleSummary {
  count: number;
  /** Files in the largest such cycle; 0 when there are none. */
  largest: number;
  /** Members of the largest, sorted and capped, for the reader to open. */
  example: string[];
}

/** Files named from one cycle before the list stops being a location. */
const MAX_EXAMPLE_FILES = 4;

const EMPTY: CycleSummary = { count: 0, largest: 0, example: [] };

export function fileCycles(
  files: readonly string[],
  importsOf: (file: string) => readonly string[],
  moduleOf: (file: string) => string | undefined,
): FileCycles {
  // A file the caller did not place in a module is not part of this component,
  // however the caller assembled its list. Leaving it in would give it a
  // module of `undefined` distinct from every real one, so a cycle out into
  // the rest of the repository and back would count as crossing.
  const inScope = new Set(files.filter((f) => moduleOf(f) !== undefined));
  // Sorted, so Tarjan's traversal order — and therefore which of two
  // equal-sized cycles is reported — is fixed by the graph rather than by the
  // order the caller happened to collect files in (AGENTS.md §1).
  const nodes = [...inScope].sort(compareStrings);
  const adjacency = new Map<string, string[]>(
    nodes.map((f) => [f, importsOf(f).filter((t) => inScope.has(t) && t !== f).sort(compareStrings)]),
  );

  const crossing: string[][] = [];
  const within: string[][] = [];
  for (const scc of stronglyConnected(nodes, adjacency)) {
    if (scc.length < 2) continue;
    const modules = new Set(scc.map(moduleOf));
    (modules.size > 1 ? crossing : within).push(scc);
  }

  return { crossing: summarize(crossing), within: summarize(within) };
}

function summarize(cycles: readonly string[][]): CycleSummary {
  if (cycles.length === 0) return EMPTY;
  const sorted = [...cycles].sort(
    (a, b) => b.length - a.length || compareStrings(a[0] ?? "", b[0] ?? ""),
  );
  const largest = sorted[0]!;
  return {
    count: cycles.length,
    largest: largest.length,
    example: [...largest].sort(compareStrings).slice(0, MAX_EXAMPLE_FILES),
  };
}
