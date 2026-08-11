import { alpha1 } from "../alpha/index.js";
import { gamma1 } from "../gamma/index.js";

export const beta1 = () => 1;
export const beta2 = () => alpha1() + gamma1();
