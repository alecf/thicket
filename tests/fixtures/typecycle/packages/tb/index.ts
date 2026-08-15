import type { TaShape } from "../ta/index.js";

export interface TbShape {
  tbLabel: string;
  tbPeer: TaShape | null;
}
