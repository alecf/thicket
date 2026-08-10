import type { FileHandle } from "../extract/types.js";
import { extractFragments, type ExtractOptions } from "./fragments.js";
import { normalizeL0, normalizeL1 } from "./normalize.js";

/**
 * One physical fragment, reduced to the only things clustering needs: where it
 * is, how big it is, and **both** of its normalized hashes.
 *
 * Both hashes travel together on purpose. The L1 suppression rule (see
 * `clusterFragments`) asks "did these fragments already agree at L0?", which
 * is unanswerable if the two levels are stored as unrelated rows. A cache that
 * cannot answer it produces a different finding set from an uncached run, and
 * a cache that changes the answer is worse than no cache at all.
 *
 * This is also the cache's row type — deliberately, so there is exactly one
 * definition of what a fragment reduces to, and no lossy translation between
 * the walked path and the cached one.
 */
export interface ShapedFragment {
  filePath: string;
  kind: string;
  nodeCount: number;
  start: number;
  end: number;
  /** 1-based line of `start`. Display only. */
  line: number;
  /** 1-based line of `end`; with `line`, the span the ranker scores in. */
  endLine: number;
  /** Pre-order ordinal of the parent node, or -1 at the top level. */
  parentId: number;
  /** Share of named leaves that are literal values; gates L1 eligibility. */
  literalShare: number;
  /** Exact normalization hash: identifier text and literal values preserved. */
  l0: string;
  /** α-renamed normalization hash: identifiers renumbered, literals dropped. */
  l1: string;
}

/**
 * Walk one file and reduce every fragment to its shape.
 *
 * The returned order is `extractFragments`' emission order (post-order, so a
 * child precedes its parent) and is preserved through the cache, because ties
 * in the cluster sort fall back to it via a stable sort.
 */
export function shapeFragments(file: FileHandle, opts: ExtractOptions): ShapedFragment[] {
  return extractFragments(file, opts).map((f) => ({
    filePath: f.filePath,
    kind: f.kind,
    nodeCount: f.nodeCount,
    start: f.start,
    end: f.end,
    line: f.line,
    endLine: f.endLine,
    parentId: f.parentId,
    literalShare: f.literalShare,
    l0: normalizeL0(f.tokensL0),
    l1: normalizeL1(f.tokensL1),
  }));
}
