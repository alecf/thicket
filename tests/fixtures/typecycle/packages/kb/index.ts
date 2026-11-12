import { kaOne } from "../ka/index.js";
import { kcValue } from "../kc/index.js";

export interface KbShape {
  kbLabel: string;
}

export const kbValue = (): number => kaOne() + kcValue();
