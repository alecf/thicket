import { describe, expect, it } from "vitest";
import { findVariants, type VariantInput } from "../src/report/variants.js";

/** A token stream of `n` distinct tokens, optionally with `extra` spliced in. */
function tokens(n: number, extra: string[] = [], at = 10): string[] {
  const base = Array.from({ length: n }, (_, i) => `t${i}`);
  base.splice(at, 0, ...extra);
  return base;
}

const input = (id: string, over: Partial<VariantInput> = {}): VariantInput => ({
  id,
  tokens: tokens(60),
  occurrences: [{ filePath: `${id}.ts`, start: 0, end: 100 }],
  copies: 5,
  ...over,
});

describe("findVariants", () => {
  it("links two findings whose shapes differ by an inserted statement", () => {
    // The case that motivated this: a template and five classes two lines away
    // from it, reported as separate findings with nothing connecting them.
    const a = input("THK-DUP-a");
    const b = input("THK-DUP-b", {
      tokens: tokens(60, ["extraIdentifiers", "?", ":", "string"]),
      occurrences: [{ filePath: "b.ts", start: 0, end: 100 }],
      copies: 19,
    });
    const links = findVariants([a, b]);
    // 0.8125 -- within a whisker of the 0.813 the real template-and-variant
    // pair scored, which is what the threshold was set against.
    expect(links.get("THK-DUP-a")).toEqual([
      { id: "THK-DUP-b", similarity: 0.8125, copies: 19 },
    ]);
    // Both directions, so whichever the reader reaches first points at the other.
    expect(links.get("THK-DUP-b")?.[0]?.id).toBe("THK-DUP-a");
    expect(links.get("THK-DUP-b")?.[0]?.copies).toBe(5);
  });

  it("does not link findings that merely share the language's phrasing", () => {
    const a = input("THK-DUP-a", { tokens: tokens(60) });
    const b = input("THK-DUP-b", {
      tokens: Array.from({ length: 60 }, (_, i) => `u${i}`),
      occurrences: [{ filePath: "b.ts", start: 0, end: 100 }],
    });
    expect(findVariants([a, b]).size).toBe(0);
  });

  it("never links a fragment to its own ancestor, however alike they are", () => {
    // PRD §5.4's fifth hazard, and not hypothetical: on a real report the two
    // most similar pairs of all scored 1.000 and 0.921 and both were a
    // fragment beside the node containing it. Exact hashing is immune to this;
    // anything measuring similarity is not.
    const shared = tokens(60);
    const outer = input("THK-DUP-outer", {
      occurrences: [{ filePath: "same.ts", start: 0, end: 500 }],
      tokens: shared,
    });
    const inner = input("THK-DUP-inner", {
      occurrences: [{ filePath: "same.ts", start: 40, end: 460 }],
      tokens: shared,
    });
    expect(findVariants([outer, inner]).size).toBe(0);
  });

  it("links findings in the same file that do not overlap", () => {
    // The complement: sharing a file is not the same as being nested, and
    // excluding by file alone would drop real variants.
    const first = input("THK-DUP-first", {
      occurrences: [{ filePath: "same.ts", start: 0, end: 100 }],
    });
    const second = input("THK-DUP-second", {
      occurrences: [{ filePath: "same.ts", start: 200, end: 300 }],
      tokens: tokens(60, ["x"]),
    });
    expect(findVariants([first, second]).get("THK-DUP-first")?.[0]?.id).toBe("THK-DUP-second");
  });

  it("treats a fragment too short to shingle as similar to nothing", () => {
    // Two two-token fragments have no signature to compare. Returning 0/0 as
    // 1.0 would make every short finding a variant of every other.
    const a = input("THK-DUP-a", { tokens: ["x", "y"] });
    const b = input("THK-DUP-b", {
      tokens: ["x", "y"],
      occurrences: [{ filePath: "b.ts", start: 0, end: 10 }],
    });
    expect(findVariants([a, b]).size).toBe(0);
  });

  it("orders variants by similarity and caps them", () => {
    const base = tokens(200);
    const subject = input("THK-DUP-subject", { tokens: base });
    const others = [0.02, 0.04, 0.06, 0.08].map((noise, i) =>
      input(`THK-DUP-o${i}`, {
        // Progressively more different, so the ordering is not the input order.
        tokens: tokens(200, Array.from({ length: Math.round(200 * noise) }, (_, k) => `n${i}-${k}`)),
        occurrences: [{ filePath: `o${i}.ts`, start: 0, end: 100 }],
      }),
    );
    const links = findVariants([subject, ...others]).get("THK-DUP-subject")!;
    expect(links).toHaveLength(3);
    expect(links.map((v) => v.id)).toEqual(["THK-DUP-o0", "THK-DUP-o1", "THK-DUP-o2"]);
    expect(links[0]!.similarity).toBeGreaterThan(links[2]!.similarity);
  });

  it("is deterministic when two variants are equally similar", () => {
    const shape = tokens(60, ["x"]);
    const subject = input("THK-DUP-subject");
    const twins = ["THK-DUP-zzz", "THK-DUP-aaa"].map((id) =>
      input(id, { tokens: shape, occurrences: [{ filePath: `${id}.ts`, start: 0, end: 100 }] }),
    );
    const forward = findVariants([subject, ...twins]).get("THK-DUP-subject")!;
    const reverse = findVariants([subject, ...twins.reverse()]).get("THK-DUP-subject")!;
    expect(forward.map((v) => v.id)).toEqual(["THK-DUP-aaa", "THK-DUP-zzz"]);
    expect(forward).toEqual(reverse);
  });
});
