import { describe, expect, it } from "vitest";
import { excerptOf } from "../src/report/excerpt.js";

describe("excerptOf", () => {
  const source = [
    "export function outer() {",
    "  if (ready) {",
    "    const value = compute(a, b);",
    "    emit(value);",
    "    log(value);",
    "    cleanup();",
    "  }",
    "}",
  ].join("\n");

  const rangeOf = (needle: string, endNeedle: string) => {
    const start = source.indexOf(needle);
    return [start, source.indexOf(endNeedle) + endNeedle.length] as const;
  };

  it("returns the fragment's own lines, dedented", () => {
    const [start, end] = rangeOf("if (ready)", "  }");
    expect(excerptOf(source, start, end, { maxLines: 8, maxColumns: 80 })).toEqual([
      "if (ready) {",
      "  const value = compute(a, b);",
      "  emit(value);",
      "  log(value);",
      "  cleanup();",
      "}",
    ]);
  });

  it("dedents by the continuation lines, not the first", () => {
    // A fragment starting mid-line -- an object literal inside a call, a
    // condition inside an `if` -- has no indentation on its first line. Taking
    // the minimum across all lines makes that zero, so nothing dedents and
    // every excerpt in the report keeps the nesting of wherever it happened to
    // sit. The first line is already flush by construction.
    const [start, end] = rangeOf("compute(a, b)", "cleanup();");
    const lines = excerptOf(source, start, end, { maxLines: 8, maxColumns: 80 });
    expect(lines[0]).toBe("compute(a, b);");
    expect(lines[1]).toBe("emit(value);");
    expect(lines[2]).toBe("log(value);");
  });

  it("caps the number of lines and says it elided", () => {
    const [start, end] = rangeOf("if (ready)", "  }");
    const lines = excerptOf(source, start, end, { maxLines: 3, maxColumns: 80 });
    expect(lines).toHaveLength(4);
    expect(lines.slice(0, 3)).toEqual([
      "if (ready) {",
      "  const value = compute(a, b);",
      "  emit(value);",
    ]);
    expect(lines[3]).toBe("…");
  });

  it("caps line width so one minified line cannot flood the report", () => {
    const wide = `const x = ${"a".repeat(400)};`;
    const lines = excerptOf(wide, 0, wide.length, { maxLines: 3, maxColumns: 40 });
    expect(lines[0]).toHaveLength(40);
    expect(lines[0]!.endsWith("…")).toBe(true);
  });

  it("is empty for a range that yields no text", () => {
    expect(excerptOf(source, 5, 5, { maxLines: 3, maxColumns: 80 })).toEqual([]);
  });
});
