import type { KbShape } from "../kb/index.js";

export const kdValue = (): number => 1;
export const kdLabel = (s: KbShape): string => s.kbLabel;
