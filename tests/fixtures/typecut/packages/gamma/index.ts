import { alpha1 } from "../alpha/index.js";
import { beta1 } from "../beta/index.js";

export const gamma1 = () => 1;
export const gamma2 = () => alpha1() + beta1();

export interface GammaId {
  id: string;
}
