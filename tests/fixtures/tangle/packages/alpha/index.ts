// Three symbols into the ring, one into the leaf. The leaf edge is the
// cheapest thing in the component and cutting it accomplishes least.
import { beta1, beta2, beta3 } from "../beta/index.js";
import { leafOne } from "../leaf/index.js";

export const alpha1 = () => beta1();
export const alpha2 = () => beta2();
export const alpha3 = () => beta3();
export const alphaLeaf = () => leafOne();
