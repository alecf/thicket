import { ownerKey } from "./owner.js";

export { OWNER_NAME } from "./owner.js";

export function userLabel(): string {
  return ownerKey("user");
}
