import { describe, expect, it } from "vitest";
import { openProject } from "../src/extract/ts-adapter.js";
import { forEachChildSafe, walk } from "../src/extract/traverse.js";
import { fixtureConfig } from "./helpers.js";

describe("forEachChildSafe", () => {
  it("visits every child even when the callback returns a truthy value", async () => {
    const project = await openProject(fixtureConfig());
    const sf = project.getSourceFile("src/beta.ts")!;

    // Ground truth: a callback returning undefined visits every child.
    let expected = 0;
    sf.forEachChild(() => { expected++; });
    expect(expected).toBeGreaterThan(1);

    // The hazard, asserted directly: raw forEachChild aborts on the first
    // truthy return, visiting exactly one child. See PRD §2.4.
    let raw = 0;
    sf.forEachChild(() => { raw++; return true; });
    expect(raw).toBe(1);

    // The wrapper must be immune to it.
    let safe = 0;
    forEachChildSafe(sf, () => { safe++; return true as unknown as void; });
    expect(safe).toBe(expected);
  });

  it("walk() visits strictly more nodes than the top level", async () => {
    const project = await openProject(fixtureConfig());
    const sf = project.getSourceFile("src/beta.ts")!;

    let top = 0;
    forEachChildSafe(sf, () => { top++; });

    let all = 0;
    walk(sf, () => { all++; });

    expect(all).toBeGreaterThan(top);
  });
});
