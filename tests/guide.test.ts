import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FEEDBACK_HEADING, guideText } from "../src/report/guide.js";
import { TASKS } from "../src/report/markdown.js";
import { renderMarkdown, renderReport, type ReportInput } from "../src/report/markdown.js";
import type { Ranked } from "../src/report/rank.js";
import { reportInput } from "./report-fixtures.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(repo, "docs/report-guide.md"), "utf8");
const URL = "https://alecf.github.io/thicket/report-guide.md";

const ranked = (id: string): Ranked => ({
  score: 100,
  tag: "source",
  linesPerCopy: 9,
  recoverableLines: 16,
  cluster: {
    id,
    level: "L0",
    kind: "Block",
    nodeCount: 20,
    mass: 40,
    occurrences: [
      { filePath: "src/alpha.ts", start: 60, end: 300, line: 4, endLine: 12, parentId: 1 },
      { filePath: "src/beta.ts", start: 10, end: 250, line: 2, endLine: 10, parentId: 3 },
    ],
  },
});

const withFinding = (over: Partial<ReportInput> = {}): ReportInput =>
  reportInput({ duplication: [ranked("THK-DUP-1")], totalFindings: 1, ...over });

describe("guideText", () => {
  it("is the guide the site publishes, byte for byte", () => {
    // The binary carries its own copy. It must not drift from the one the
    // linked URL serves, or `--embed` and the link teach different things.
    expect(guideText({ private: false })).toBe(source);
  });

  it("ends with the feedback section, so a private copy can cut it off", () => {
    expect(source.split(`\n${FEEDBACK_HEADING}\n`)).toHaveLength(2);
    const after = source.slice(source.indexOf(`\n${FEEDBACK_HEADING}\n`) + 1);
    // No second-level heading follows it outside a fence. One would be cut too.
    let fenced = false;
    for (const line of after.split("\n").slice(1)) {
      if (line.startsWith("```")) fenced = !fenced;
      if (!fenced) expect(line.startsWith("## ")).toBe(false);
    }
  });

  it("cuts a CRLF checkout the same way, and emits LF either way", () => {
    // Windows with core.autocrlf checks the guide out with CRLF. A cut keyed
    // on "\n## " found nothing there and threw, so no report was produced.
    const crlf = source.replaceAll("\n", "\r\n");
    expect(guideText({ private: false }, crlf)).toBe(source);
    expect(guideText({ private: true }, crlf)).toBe(guideText({ private: true }));
  });

  it("never asks for the header's file or line counts in an issue", () => {
    // The header line carries `N files / N LOC`. The privacy list forbids
    // both, so an instruction to copy that line leaked them.
    const feedback = source.slice(source.indexOf(FEEDBACK_HEADING));
    expect(feedback).not.toMatch(/version line/);
    expect(feedback).toContain("file counts or line counts");
  });

  it("drops only the feedback section when private", () => {
    const text = guideText({ private: true });
    expect(text).not.toContain(FEEDBACK_HEADING);
    expect(text).not.toContain("gh issue create");
    expect(text).toContain("## Working with the report");
    expect(source.startsWith(text.trimEnd())).toBe(true);
  });
});

describe("report guide modes", () => {
  it("links the guide and says nothing about privacy by default", () => {
    const out = renderMarkdown(withFinding());
    expect(out).toContain(`**How to read this report:** ${URL}`);
    expect(out).not.toContain("# How to read a thicket report");
    expect(out).not.toMatch(/private/i);
  });

  it("--private keeps the link and forbids filing issues, above the summary", () => {
    const out = renderMarkdown(withFinding({ private: true }));
    expect(out).toContain(`**How to read this report:** ${URL}`);
    const line = out.indexOf("**Private report.**");
    expect(line).toBeGreaterThan(-1);
    expect(line).toBeLessThan(out.indexOf("## Summary"));
    // The linked guide still holds the section, so the header has to name it.
    expect(out).toContain(FEEDBACK_HEADING.replace(/^## /, ""));
  });

  it("--embed appends the whole guide after the findings and drops the URL", () => {
    const out = renderMarkdown(withFinding({ embedGuide: true }));
    expect(out).not.toContain(URL);
    expect(out.endsWith(source)).toBe(true);
    expect(out.indexOf("THK-DUP-1")).toBeLessThan(out.indexOf("# How to read a thicket report"));
    expect(out.indexOf("How to read this report")).toBeLessThan(out.indexOf("## Summary"));
  });

  it("--embed --private embeds the guide without the feedback section", () => {
    const out = renderMarkdown(withFinding({ embedGuide: true, private: true }));
    expect(out).toContain("**Private report.**");
    // The section is gone, so the notice must not send the agent looking for it.
    expect(out).not.toContain("Skip the guide's section");
    expect(out).toContain("## Working with the report");
    expect(out).not.toContain(FEEDBACK_HEADING);
    expect(out).not.toContain("gh issue create");
  });

  it("counts an embedded guide against the token budget", () => {
    // The budget is a ceiling on what lands in a context window. The guide
    // lands there too, so a budget that fits a finding beside a link does not
    // fit it beside the whole guide.
    const budgetTokens = 2000;
    expect(renderReport(withFinding({ budgetTokens })).shown).toBe(1);
    const { markdown, shown } = renderReport(withFinding({ budgetTokens, embedGuide: true }));
    expect(shown).toBe(0);
    // Said in the report, or an empty report reads as a clean codebase.
    expect(markdown).toMatch(/The embedded guide is about \d+ tokens, and it counts against the budget of 2000\./);
  });

  it("says nothing about the guide's cost when the budget did not cut anything", () => {
    const out = renderMarkdown(withFinding({ budgetTokens: 100_000, embedGuide: true }));
    expect(out).not.toContain("The embedded guide is about");
  });
});

describe("--task", () => {
  it("prints no task line unless asked, so the person's own prompt decides", () => {
    expect(renderMarkdown(withFinding())).not.toContain("**Task:");
  });

  it.each(["triage", "fix", "pr"] as const)("states the %s task above the summary", (task) => {
    const out = renderMarkdown(withFinding({ task }));
    const line = out.indexOf(`**Task: ${task}.**`);
    expect(line).toBeGreaterThan(-1);
    expect(line).toBeLessThan(out.indexOf("## Summary"));
  });

  it("forbids edits in triage and limits fix to one finding", () => {
    expect(renderMarkdown(withFinding({ task: "triage" }))).toContain("Do not edit any file.");
    expect(renderMarkdown(withFinding({ task: "fix" }))).toContain("Fix one finding only.");
  });

  it("asks fix and pr for the typecheck and the original command, without the guide", () => {
    // Each line has to stand alone in a linked report. vitest does not
    // typecheck, and the report shows a config hash, not the flags.
    for (const task of ["fix", "pr"] as const) {
      const out = renderMarkdown(withFinding({ task }));
      expect(out).toContain("typecheck");
      expect(out).toContain("same command");
    }
  });

  it("names every task in one list the CLI, the type and the lines share", () => {
    expect([...TASKS]).toEqual(["triage", "fix", "pr"]);
    for (const task of TASKS) expect(renderMarkdown(withFinding({ task }))).toContain(`**Task: ${task}.**`);
  });

  it("is explained in the guide, before the feedback section a private copy cuts", () => {
    // A private embedded guide must still explain the task it was given.
    const text = guideText({ private: true });
    expect(text).toContain("## Your task");
    for (const task of ["triage", "fix", "pr"]) expect(text).toContain(`### \`${task}\``);
  });
});
