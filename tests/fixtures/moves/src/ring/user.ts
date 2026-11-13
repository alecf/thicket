import { ringKey } from "./owner.js";

export function userName(): string {
  return ringKey("user");
}
