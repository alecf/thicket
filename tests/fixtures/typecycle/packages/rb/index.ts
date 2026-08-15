import type { RaShape } from "../ra/index.js";

export interface RbShape {
  rbLabel: string;
  rbPeer: RaShape | null;
}

export const rbValue = (): number => 1;
