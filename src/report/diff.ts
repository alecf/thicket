import { compareStrings } from "../order.js";

/**
 * The subset of the JSON sidecar a diff needs. Deliberately structural and
 * minimal: `ReportJson` satisfies it, and so does a sidecar written by a
 * slightly older thicket that has since grown a field. A diff that refused to
 * run across a version boundary would be useless in exactly the situation it
 * exists for — comparing a report from before a change to one from after.
 */
export interface DiffableMetrics {
  duplicatedMass: number;
  redundantByteFraction: number;
  propagationCost: number;
  cycleCount: number;
  largestScc: number;
}

export interface DiffableReport {
  metrics: DiffableMetrics;
  duplication: readonly { id: string }[];
  cycles: readonly { id: string }[];
}

export interface MetricDelta {
  before: number;
  after: number;
}

export interface ReportDiff {
  /** Present before, gone after. The only list that means work got done. */
  resolved: string[];
  /** Absent before, present after. */
  added: string[];
  /** Present in both — the finding survived, wherever its code now lives. */
  unchanged: string[];
  /**
   * Percentage change in duplicated mass. Mass is the overlapping trend
   * number, not a fraction of anything (see `ReportInput.metrics`), so this is
   * a direction and a rough magnitude rather than a share of the codebase.
   */
  massDeltaPct: number;
  metrics: Record<keyof DiffableMetrics, MetricDelta>;
}

const METRIC_KEYS = [
  "duplicatedMass",
  "redundantByteFraction",
  "propagationCost",
  "cycleCount",
  "largestScc",
] as const;

/**
 * Compares two reports by finding id and by metric scalar.
 *
 * This works only because ids are derived from content rather than position
 * (`findingId`): a duplicated block that merely moved keeps its id and shows
 * up as unchanged, so `resolved` counts refactors and not edits. If ids ever
 * became position-derived, every list here would fill with noise and the diff
 * would report progress on every commit that touched a line.
 */
export function diffReports(before: DiffableReport, after: DiffableReport): ReportDiff {
  const beforeIds = idsOf(before);
  const afterIds = idsOf(after);

  const metrics = {} as Record<keyof DiffableMetrics, MetricDelta>;
  for (const key of METRIC_KEYS) {
    metrics[key] = { before: before.metrics[key], after: after.metrics[key] };
  }

  return {
    resolved: sorted([...beforeIds].filter((id) => !afterIds.has(id))),
    added: sorted([...afterIds].filter((id) => !beforeIds.has(id))),
    unchanged: sorted([...beforeIds].filter((id) => afterIds.has(id))),
    massDeltaPct: percentChange(before.metrics.duplicatedMass, after.metrics.duplicatedMass),
    metrics,
  };
}

/** Both finding kinds share one id space, so they share one diff. */
function idsOf(report: DiffableReport): Set<string> {
  return new Set([...report.duplication, ...report.cycles].map((f) => f.id));
}

function sorted(ids: readonly string[]): string[] {
  return [...ids].sort(compareStrings);
}

/**
 * Percentage change, with the zero-denominator case answered rather than
 * propagated. `0 → n` has no finite percentage, and both plausible
 * placeholders are wrong in a way that matters: `Infinity` breaks any harness
 * that formats or thresholds the number, and `0` claims nothing changed while
 * duplication appeared. `100` reads as "all of the current mass is new", which
 * is exactly what happened.
 */
function percentChange(before: number, after: number): number {
  if (before === 0) return after === 0 ? 0 : 100;
  return ((after - before) / before) * 100;
}

/**
 * One line, in the shape PRD §9.1 specifies. ASCII throughout: this is read by
 * `grep` and by harness regexes at least as often as by a human.
 */
export function formatDiff(diff: ReportDiff): string {
  const mass = diff.metrics.duplicatedMass;
  const noun = diff.resolved.length === 1 ? "finding" : "findings";
  return (
    `${diff.resolved.length} ${noun} resolved, ${diff.added.length} new, ` +
    `duplicated mass ${signed(diff.massDeltaPct)}% ` +
    `(${mass.before} -> ${mass.after}), ` +
    `propagation cost ${diff.metrics.propagationCost.before.toFixed(2)} -> ` +
    `${diff.metrics.propagationCost.after.toFixed(2)}`
  );
}

function signed(pct: number): string {
  return `${pct > 0 ? "+" : ""}${pct.toFixed(1)}`;
}

/**
 * Validates a parsed JSON file as a report before diffing it.
 *
 * The two arguments to `thicket diff` are paths a human typed, so the wrong
 * file is the common case. Without this the failure is a `TypeError` about
 * reading a property of undefined, which names neither file; with it the
 * message names the one that is wrong.
 */
export function parseReport(value: unknown, source: string): DiffableReport {
  const bad = (why: string): never => {
    throw new Error(`${source} is not a thicket report: ${why}`);
  };

  if (typeof value !== "object" || value === null) bad("not a JSON object");
  const record = value as Record<string, unknown>;

  const metrics = record["metrics"];
  if (typeof metrics !== "object" || metrics === null) bad("no \"metrics\" object");
  const metricRecord = metrics as Record<string, unknown>;
  for (const key of METRIC_KEYS) {
    if (typeof metricRecord[key] !== "number") bad(`metrics.${key} is not a number`);
  }

  return {
    metrics: metricRecord as unknown as DiffableMetrics,
    duplication: findings(record["duplication"], "duplication", bad),
    cycles: findings(record["cycles"], "cycles", bad),
  };
}

function findings(
  value: unknown,
  field: string,
  bad: (why: string) => never,
): { id: string }[] {
  if (!Array.isArray(value)) bad(`"${field}" is not an array`);
  return (value as unknown[]).map((entry, i) => {
    if (typeof entry !== "object" || entry === null) bad(`${field}[${i}] is not an object`);
    const id = (entry as Record<string, unknown>)["id"];
    if (typeof id !== "string") bad(`${field}[${i}] has no string "id"`);
    return { id: id as string };
  });
}
