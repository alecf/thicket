// `user.ts` imports `ownerKey` and also re-exports `OWNER_NAME`. Moving
// `ownerKey` out leaves the re-export, and the re-export keeps the cycle.
import { userLabel } from "./user.js";

export const OWNER_NAME = "owner";

export function ownerKey(id: string): string {
  return `${OWNER_NAME}:${id}`;
}

export function ownerLabel(): string {
  return userLabel();
}
