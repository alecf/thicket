import { describe, expect, it } from "vitest";
import { findCoLocated, findVariants, type VariantInput } from "../src/report/variants.js";
import { runReport } from "../src/run.js";
import { coLocatedConfig } from "./helpers.js";

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

describe("findCoLocated", () => {
  /**
   * A finding over `files`, one copy in each.
   *
   * `at` is a distinct byte offset per finding, because two findings sharing a
   * file sit at different places in it. Give two of them the same range and
   * `overlaps` reads them as a fragment and its own ancestor and refuses to
   * link them, so every assertion below passes vacuously.
   */
  let nextAt = 0;
  const over = (id: string, files: string[], copies = files.length): VariantInput => {
    const at = (nextAt += 1000);
    return {
      id,
      tokens: tokens(60),
      occurrences: files.map((filePath) => ({ filePath, start: at, end: at + 100 })),
      copies,
    };
  };

  it("links a finding whose files are all covered by another", () => {
    // Ten of 59 findings on a real application described one structure: seven
    // sibling files under `sections/` repeating eight different shapes between
    // them. A reader saw ten problems and rebuilt the one by hand. Two of those
    // findings covered the IDENTICAL seven files.
    const small = over("THK-DUP-small", ["src/a.ts", "src/b.ts", "src/c.ts"]);
    const big = over("THK-DUP-big", ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]);
    const links = findCoLocated([small, big]);
    // The contained finding is told that everything it touches is also touched
    // by the larger one.
    expect(links.get("THK-DUP-small")).toEqual([
      { id: "THK-DUP-big", files: 3, within: true, copies: 4 },
    ]);
    // ...and the larger one is told where the smaller sits inside it.
    expect(links.get("THK-DUP-big")).toEqual([
      { id: "THK-DUP-small", files: 3, within: false, copies: 3 },
    ]);
  });

  it("links two findings over exactly the same files in both directions", () => {
    const a = over("THK-DUP-a", ["src/a.ts", "src/b.ts"]);
    const b = over("THK-DUP-b", ["src/a.ts", "src/b.ts"]);
    // Equal sets contain each other, so each is told it is fully covered.
    expect(links(a, b, "THK-DUP-a")?.within).toBe(true);
    expect(links(a, b, "THK-DUP-b")?.within).toBe(true);
  });
  const links = (a: VariantInput, b: VariantInput, id: string) => findCoLocated([a, b]).get(id)?.[0];

  it("says nothing when the file sets merely overlap", () => {
    // Deliberately NOT a similarity threshold. Measured over the 59 findings of
    // a real report, file-set Jaccard decayed smoothly from 1.0 with no empty
    // band anywhere, so any cutoff would have been arbitrary. Containment is a
    // fact instead: acting on the covering finding's files reaches every copy
    // of the covered one, and acting on a partial overlap does not.
    const a = over("THK-DUP-a", ["src/a.ts", "src/b.ts", "src/c.ts"]);
    const b = over("THK-DUP-b", ["src/b.ts", "src/c.ts", "src/d.ts"]);
    expect(findCoLocated([a, b]).size).toBe(0);
  });

  it("never links a fragment to its own ancestor", () => {
    // A finding and the node containing it trivially share every file, and they
    // are the same code seen at two granularities. Same hazard `findVariants`
    // guards, reached by a different route: on a real report the Storybook
    // `meta` object and the `parameters` block inside it were two findings over
    // the same 22 files.
    const outer: VariantInput = {
      id: "THK-DUP-outer",
      tokens: tokens(60),
      occurrences: [{ filePath: "same.ts", start: 0, end: 500 }],
      copies: 3,
    };
    const inner: VariantInput = {
      id: "THK-DUP-inner",
      tokens: tokens(60),
      occurrences: [{ filePath: "same.ts", start: 40, end: 460 }],
      copies: 3,
    };
    expect(findCoLocated([outer, inner]).size).toBe(0);
  });

  it("caps by the OTHER finding's size, not by the shared count", () => {
    // A finding contained by several larger ones reports the same `files` for
    // every link, because `files` is its own set size in that direction. Sort
    // on that and the cap falls back to the id, which can drop the broadest
    // relative -- the one most worth reading, since it holds the most context.
    const small = over("THK-DUP-small", ["src/a.ts"]);
    const wide = over("THK-DUP-zwide", ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]);
    const mid = over("THK-DUP-ymid", ["src/a.ts", "src/b.ts", "src/c.ts"]);
    const near = over("THK-DUP-xnear", ["src/a.ts", "src/b.ts"]);
    const tiny = over("THK-DUP-atiny", ["src/a.ts"]);
    const found = findCoLocated([small, wide, mid, near, tiny]).get("THK-DUP-small")!;
    // Every link reports `files: 1`, so the ids are the only tie-break left --
    // and `THK-DUP-atiny` sorts first by id while being the least informative.
    expect(found.map((c) => c.files)).toEqual([1, 1, 1]);
    expect(found.map((c) => c.id)).toEqual([
      "THK-DUP-zwide",
      "THK-DUP-ymid",
      "THK-DUP-xnear",
    ]);
  });

  it("names the largest relatives first, and caps the list", () => {
    const base = over("THK-DUP-base", ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]);
    const inside = ["one", "two", "three", "four"].map((n, i) =>
      over(`THK-DUP-${n}`, ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"].slice(0, 4 - i)),
    );
    const found = findCoLocated([base, ...inside]).get("THK-DUP-base")!;
    expect(found.map((c) => c.files)).toEqual([4, 3, 2]);
  });
});

describe("a report over parallel sibling modules", () => {
  it("says in both directions which findings share files", async () => {
    // The unit tests above prove `findCoLocated` computes the links. This
    // proves the report asks for them and prints them: delete either and the
    // report renders without a word of it, and every assertion above stays
    // green.
    //
    // `minNodes` is raised so a function and its own body do not both cluster.
    // They are one piece of code at two granularities, `overlaps` already
    // refuses to link them, and at the default they merely crowd the output
    // this test reads.
    const { markdown } = await runReport({
      config: coLocatedConfig(),
      cache: false,
      minNodes: 30,
    });
    // The contained finding, told everything it touches is touched again.
    expect(markdown).toMatch(
      /\*\*all 2 of these files also carry `THK-DUP-[0-9a-f]{8}`:\*\* 4 copies there/,
    );
    // The containing finding, told where the smaller one sits inside it.
    expect(markdown).toMatch(
      /\*\*`THK-DUP-[0-9a-f]{8}` lives only in 2 of these files:\*\* 2 copies there/,
    );
  });
});
