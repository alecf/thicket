import { describe, expect, it } from "vitest";
import { runReport } from "../src/run.js";
import { placementConfig } from "./helpers.js";

describe("placement in the report", () => {
  it("names the copy's file that closes a cycle, and the packages that cannot share", async () => {
    const { markdown, json } = await runReport({ config: [placementConfig()], cache: false });
    expect(markdown).toContain("- **do not extract into:** `src/cart.ts` (closes a cycle with `src/invoice.ts`)");
    // The safe home is not named as one to avoid.
    expect(markdown).not.toContain("`src/invoice.ts` (closes");
    expect(markdown).toContain(
      "- **across packages:** the copies are in `packages/css` and `packages/html`," +
        " and no copy's file is in a package all the others can import.",
    );

    // One package, so the report names the directory for a new file.
    expect(markdown).toContain("- **extract into:** a new file under `src/`, with a name of your choosing");

    const cart = json.duplication.find((d) => d.occurrences.some((o) => o.filePath === "src/cart.ts"));
    expect(cart?.avoid).toEqual([{ file: "src/cart.ts", reason: { kind: "cycle", with: "src/invoice.ts" } }]);
    expect(cart?.newFileDir).toBe("src");
    const uri = json.duplication.find((d) => d.occurrences.some((o) => o.filePath === "packages/css/src/uri.ts"));
    expect(uri?.avoid).toEqual([
      { file: "packages/css/src/uri.ts", reason: { kind: "package", from: "packages/html" } },
      { file: "packages/html/src/uri.ts", reason: { kind: "package", from: "packages/css" } },
    ]);
    // Two packages: no directory is named.
    expect(uri?.newFileDir).toBeUndefined();
  });

  it("drops the check with --no-placement, and the config hash says so", async () => {
    const on = await runReport({ config: [placementConfig()], cache: false });
    const off = await runReport({ config: [placementConfig()], cache: false, placement: false });
    expect(off.markdown).not.toContain("do not extract into");
    expect(off.markdown).not.toContain("across packages");
    expect(off.markdown).not.toContain("extract into:");
    expect(off.json.duplication.every((d) => d.avoid === undefined)).toBe(true);
    // The findings themselves are the same. Only the line is gone.
    expect(off.json.duplication.map((d) => d.id)).toEqual(on.json.duplication.map((d) => d.id));
    expect(off.json.configHash).not.toBe(on.json.configHash);
  });
});
