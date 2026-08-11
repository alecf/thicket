// A three-package clique that no single edge can break, with one package
// attached to it by type-only edges alone.
//
// Cutting either `shape` edge detaches a module and is therefore the BEST
// available cut by dissolution -- and it is worthless, because both edges are
// erased at compile time and nothing on them exists at runtime. This is the
// exact shape of a real 12-module tangle whose suggested cut an agent executed
// in ten minutes and correctly reported as a no-op.
import { beta1 } from "../beta/index.js";
import { gamma1 } from "../gamma/index.js";
import type { Shape } from "../shape/index.js";

export const alpha1 = () => beta1() + gamma1();
export const alphaShaped = (s: Shape) => s.id;
