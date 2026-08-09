// Every import form that carries a different binding count, in one file:
// default + named + type-only named (4), namespace (1), side-effect (0),
// type-only clause (1), re-export (1), wildcard re-export (1),
// namespace re-export (1), dynamic (0).
import d, { K, L, type T } from "./dep.js";
import * as ns from "./dep.js";
import "./side.js";
import type { T as T2 } from "./dep.js";

export { K as K2 } from "./dep.js";
export * from "./side.js";
export * as sideNs from "./side.js";

const lazy = (): Promise<unknown> => import("./dep.js");

export const use = [d, K, L, ns, lazy] as const;
export type X = T | T2;
