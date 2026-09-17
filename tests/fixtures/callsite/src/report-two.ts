export function renderTwo(items: readonly { label: string; total: number }[]) {
  const out: string[] = [];
  for (const item of items) {
    out.push(`${item.label}: ${item.total}`);
  }
  out.push("---");
  out.push(`count: ${items.length}`);
  return out.join("\n");
}
