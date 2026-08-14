import { describe, expect, it } from "vitest";
import { fieldNameDrift, variations } from "../src/report/variation.js";

/**
 * The token stream of `static readonly <prop> = <value>;`, in the shape
 * `extractFragments` produces: a parenthesized pre-order of kind names whose
 * leaves carry the identifier text or the literal value.
 */
function property(prop: string, value: string): string[] {
  return ["PropertyDeclaration", "(", `Id:${prop}`, ")", "(", `StringLiteral:"${value}"`, ")"];
}

describe("variations", () => {
  it("names the constant a varying literal sits under", () => {
    // The ask this exists for. A finding said 19 classes are the same and
    // stopped; what an agent actually needed -- and rebuilt by hand -- was the
    // small table of what DIFFERS, because it turns "19 similar classes" into
    // "19 rows of a config table" and hands you the parameter list.
    const copies = [
      property("loincCode", "39156-5"),
      property("loincCode", "41982-0"),
      property("loincCode", "73964-9"),
    ];
    expect(variations(copies)).toEqual([{ label: "loincCode", values: 3, saturated: true }]);
  });

  it("counts distinct values, not copies", () => {
    const copies = [
      property("unit", "kg"),
      property("unit", "kg"),
      property("unit", "kcal"),
    ];
    expect(variations(copies)).toEqual([{ label: "unit", values: 2, saturated: false }]);
  });

  it("says nothing when the copies are identical", () => {
    // An L0 cluster is exact, so there is nothing to vary and the line is
    // correctly absent rather than empty.
    const copy = property("unit", "kg");
    expect(variations([copy, [...copy]])).toEqual([]);
  });

  it("reports several varying constants in source order", () => {
    // Source order, not frequency: the reader is looking at an excerpt of the
    // same code, and the list should read in the order they will meet them.
    const copies = [
      [...property("loincCode", "1"), ...property("unit", "kg")],
      [...property("loincCode", "2"), ...property("unit", "kcal")],
    ];
    expect(variations(copies)).toEqual([
      { label: "loincCode", values: 2, saturated: true },
      { label: "unit", values: 2, saturated: true },
    ]);
  });

  it("groups every varying token under the same constant once", () => {
    const copies = [
      ["PropertyDeclaration", "(", "Id:range", ")", "(", "Num:1", ")", "(", "Num:2", ")"],
      ["PropertyDeclaration", "(", "Id:range", ")", "(", "Num:3", ")", "(", "Num:4", ")"],
    ];
    expect(variations(copies)).toEqual([{ label: "range", values: 2, saturated: true }]);
  });

  it("says nothing when only identifiers differ", () => {
    // That is exactly what an L1 match means, and reporting each renamed local
    // under whatever identifier happens to precede it buries the constants
    // that ARE the parameter list under a dozen `x`, `y`, `sqrt`.
    const copies = [
      ["ClassDeclaration", "(", "Id:BMIObservation", ")"],
      ["ClassDeclaration", "(", "Id:BodyFatObservation", ")"],
    ];
    expect(variations(copies)).toEqual([]);
  });

  it("does not use a varying identifier as a label for what follows it", () => {
    // The label has to be something the reader can find in every copy. An
    // identifier that itself differs names nothing.
    const copies = [
      ["Decl", "(", "Id:alpha", ")", "(", 'StringLiteral:"x"', ")"],
      ["Decl", "(", "Id:beta", ")", "(", 'StringLiteral:"y"', ")"],
    ];
    expect(variations(copies)).toEqual([{ label: "an unnamed literal", values: 2, saturated: true }]);
  });

  it("says nothing when the streams do not line up", () => {
    // Only fragments that matched at L1 are positionally comparable. Anything
    // else would produce a confident list of nonsense.
    expect(variations([property("a", "1"), ["PropertyDeclaration"]])).toEqual([]);
  });

  it("says nothing for a single copy", () => {
    expect(variations([property("a", "1")])).toEqual([]);
  });

  it("caps how many it names", () => {
    const copies = [0, 1].map((n) =>
      Array.from({ length: 10 }, (_, i) => property(`p${i}`, `v${n}${i}`)).flat(),
    );
    expect(variations(copies)).toHaveLength(6);
    expect(variations(copies)[0]).toEqual({ label: "p0", values: 2, saturated: true });
  });
});

describe("fieldNameDrift", () => {
  const prop = (name: string, base: string) => [
    "PropertyAssignment", "(", `Id:${name}`, ")", "(", "PropertyAccessExpression",
    "(", `Id:${base}`, ")", "(", `Id:${name}`, ")", ")",
  ];

  it("reports every key varying when the copies are differently-shaped objects", () => {
    // `{ labOrderId: p.labOrderId, ... }` and `{ average: s.average, ... }` are
    // both three-field projections and are not copies of one another. On a real
    // report 193 such expressions clustered as one finding with 89 distinct
    // key-sets, 62 of them appearing exactly once -- consolidating them yields
    // a generic no future change can benefit from.
    const copies = [
      [...prop("labOrderId", "p"), ...prop("memberId", "p")],
      [...prop("average", "s"), ...prop("min", "s")],
    ];
    expect(fieldNameDrift(copies)).toEqual({ varying: 2, total: 2 });
  });

  it("reports no drift when the keys are constant and only values vary", () => {
    // The 19 duplicated observation classes: `loincCode` is the same field in
    // every copy, and what differs is the string it holds. That is one concept
    // with a parameter list, and a base class absorbs it.
    const copies = [
      ["PropertyDeclaration", "(", "Id:loincCode", ")", "(", 'StringLiteral:"39156-5"', ")"],
      ["PropertyDeclaration", "(", "Id:loincCode", ")", "(", 'StringLiteral:"41982-0"', ")"],
    ];
    expect(fieldNameDrift(copies)).toEqual({ varying: 0, total: 1 });
  });

  it("does not count a renamed local as a drifting field", () => {
    // Same logic with different binding names is exactly what an L1 match
    // means, and it is extractable. Only NAMES OF FIELDS say the copies are
    // different things.
    const copies = [
      ["Block", "(", "VariableDeclaration", "(", "Id:dx", ")", ")"],
      ["Block", "(", "VariableDeclaration", "(", "Id:deltaX", ")", ")"],
    ];
    expect(fieldNameDrift(copies)).toEqual({ varying: 0, total: 0 });
  });

  it("reports a partial drift as partial", () => {
    const copies = [
      [...prop("id", "x"), ...prop("alpha", "x")],
      [...prop("id", "x"), ...prop("beta", "x")],
    ];
    expect(fieldNameDrift(copies)).toEqual({ varying: 1, total: 2 });
  });

  it("says nothing for a single copy or for streams that do not line up", () => {
    expect(fieldNameDrift([prop("a", "x")])).toEqual({ varying: 0, total: 0 });
    expect(fieldNameDrift([prop("a", "x"), ["PropertyAssignment"]])).toEqual({
      varying: 0,
      total: 0,
    });
  });

  it("counts a method name as a field name", () => {
    // `{ debug: vi.fn(), info: vi.fn() }` vs `{ setTag: …, setLevel: … }` are
    // different mocks, not copies.
    const copies = [
      ["MethodDeclaration", "(", "Id:debug", ")"],
      ["MethodDeclaration", "(", "Id:setTag", ")"],
    ];
    expect(fieldNameDrift(copies)).toEqual({ varying: 1, total: 1 });
  });
});

describe("a count that hit the sampling cap", () => {
  // `values` counts distinct values within the sampled copies, never across
  // all of them. When every sampled copy differs the count saturates, and a
  // bare number then reads as a measured total -- which inverts the reading.
  // On a real report "103 copies, description (20)" said "a small enumerable
  // parameter set, build a table"; the truth was 101 distinct descriptions,
  // which says the opposite: it must stay a free parameter. An agent designed
  // the wrong abstraction on the strength of that number.
  it("is marked as a floor, not reported as a total", () => {
    const copies = Array.from({ length: 4 }, (_, i) => ["Id:x", "=", `Str:v${i}`]);
    const [v] = variations(copies);
    expect(v).toBeDefined();
    expect(v!.values).toBe(4);
    // Every sampled copy differed, so the true count is only known to be ≥ 4.
    expect(v!.saturated).toBe(true);
  });

  it("is not marked when the values genuinely repeat", () => {
    const copies = [
      ["Id:x", "=", "Str:a"],
      ["Id:x", "=", "Str:b"],
      ["Id:x", "=", "Str:a"],
      ["Id:x", "=", "Str:b"],
    ];
    const [v] = variations(copies);
    expect(v!.values).toBe(2);
    expect(v!.saturated).toBe(false);
  });
});
