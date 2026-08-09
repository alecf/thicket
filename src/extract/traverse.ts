import type { Node } from "./types.js";

/**
 * TypeScript's forEachChild ABORTS and returns early if the callback returns a
 * truthy value. That is useful for search, catastrophic for enumeration: a
 * callback that leaks a return value silently visits only the first child.
 * Always traverse through this wrapper. See PRD §2.4.
 */
export function forEachChildSafe(node: Node, cb: (child: Node) => unknown): void {
  node.forEachChild((child: Node) => {
    cb(child);
    return undefined; // never propagate the callback's value
  });
}

/** Depth-first pre-order walk over every descendant, inclusive of `node`. */
export function walk(node: Node, visit: (n: Node) => void): void {
  visit(node);
  forEachChildSafe(node, (c) => walk(c, visit));
}
