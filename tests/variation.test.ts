import { describe, expect, it } from "vitest";
import { variations } from "../src/report/variation.js";

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
    expect(variations(copies)).toEqual([{ label: "loincCode", values: 3 }]);
  });

  it("counts distinct values, not copies", () => {
    const copies = [
      property("unit", "kg"),
      property("unit", "kg"),
      property("unit", "kcal"),
    ];
    expect(variations(copies)).toEqual([{ label: "unit", values: 2 }]);
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
      { label: "loincCode", values: 2 },
      { label: "unit", values: 2 },
    ]);
  });

  it("groups every varying token under the same constant once", () => {
    const copies = [
      ["PropertyDeclaration", "(", "Id:range", ")", "(", "Num:1", ")", "(", "Num:2", ")"],
      ["PropertyDeclaration", "(", "Id:range", ")", "(", "Num:3", ")", "(", "Num:4", ")"],
    ];
    expect(variations(copies)).toEqual([{ label: "range", values: 2 }]);
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
    expect(variations(copies)).toEqual([{ label: "an unnamed literal", values: 2 }]);
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
    expect(variations(copies)[0]).toEqual({ label: "p0", values: 2 });
  });
});
