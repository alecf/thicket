import { hash } from "../hash.js";

export type FindingKind = "DUP" | "CYC" | "INV";

/**
 * Derived from CONTENT, never position, so a finding keeps its id as the file
 * around it changes. This is what makes reports diffable across loop
 * iterations, which is how the harness distinguishes progress from churn.
 * See PRD §9.1.
 */
export function findingId(kind: FindingKind, contentKey: string): string {
  return `THK-${kind}-${hash(contentKey).slice(0, 8)}`;
}
