// Two packages that are bundled on their own. Neither depends on the other,
// so neither copy's file can hold a shared version.
export function joinPath(base: string, parts: string[]): string {
  let out = base.endsWith("/") ? base.slice(0, -1) : base;
  for (const part of parts) {
    const clean = part.replace(/^\/+|\/+$/g, "");
    if (clean.length > 0) out = `${out}/${clean}`;
  }
  return out;
}
