import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM, no types; the site build is dependency-free on purpose.
import { build, markdownToHtml } from "../site/build.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(repo, "site/dist");

/** Built once: the build is a pure function of the repo's files. */
const emitted: string[] = build();
const read = (name: string) => readFileSync(join(dist, name), "utf8");

describe("the site build", () => {
  it("emits every page the site links to", () => {
    expect(emitted).toEqual([
      "index.html",
      "report-guide.html",
      "report-guide.md",
      "example.html",
      "icon.svg",
    ]);
  });

  it("serves the report guide as unaltered Markdown", () => {
    // Load-bearing: every report thicket emits links to this exact URL, and
    // the reader on the other end is a model that expects Markdown. Rendering
    // it to HTML at that path, or letting it drift from the source, breaks the
    // one integration the report promises.
    const source = readFileSync(join(repo, "docs/report-guide.md"), "utf8");
    expect(read("report-guide.md")).toBe(source);
  });

  it("publishes the guide at the URL the report prints", () => {
    const markdown = readFileSync(join(repo, "src/report/markdown.ts"), "utf8");
    const url = /const GUIDE_URL = "([^"]+)"/.exec(markdown)?.[1];
    expect(url).toBe("https://alecf.github.io/thicket/report-guide.md");
    // The path after the site root must be a file the build actually writes.
    expect(emitted).toContain(url!.split("/").pop());
  });

  it("shows the golden report as its example, byte for byte", () => {
    // The site cannot advertise output the tool would not produce: the example
    // page is generated from the same fixture report the suite pins.
    const golden = readFileSync(join(repo, "tests/golden/sample-report.md"), "utf8");
    const html = read("example.html");
    expect(golden).toContain("THK-DUP-");
    for (const id of golden.match(/THK-(?:DUP|CYC)-[0-9a-f]{8}/g) ?? []) {
      expect(html).toContain(id);
    }
  });

  it("keeps the example's mermaid chart as a chart, not as escaped source", () => {
    const html = read("example.html");
    expect(html).toContain('<pre class="mermaid">');
    expect(html).toContain("flowchart LR");
  });

  it("leaves a .nojekyll marker so underscore paths survive Pages", () => {
    expect(() => read(".nojekyll")).not.toThrow();
  });

  it("writes no absolute filesystem paths into the output", () => {
    for (const name of ["index.html", "report-guide.html", "example.html"]) {
      expect(read(name)).not.toContain("/Users/");
    }
  });
});

describe("the Markdown subset the site renders", () => {
  it("does not read Markdown punctuation inside a code span as formatting", () => {
    // The guide is full of spans like `**bold**` describing the report's own
    // syntax. Escaping code spans after emphasis would turn them into markup.
    const html = markdownToHtml("Use `**not bold**` here.");
    expect(html).toContain("<code>**not bold**</code>");
    expect(html).not.toContain("<strong>");
  });

  it("closes a wide fence at the wide marker, not at an inner one", () => {
    // Both worked examples in the guide are four-backtick blocks CONTAINING
    // three-backtick fences. Closing at the first inner marker truncates the
    // example and spills the rest of the page into a code block.
    const html = markdownToHtml("````\nouter\n```ts\ninner\n```\nstill outer\n````\nafter\n");
    expect(html).toContain("still outer");
    expect(html).toContain("<p>after</p>");
    expect(html.match(/<pre>/g)).toHaveLength(1);
  });

  it("escapes HTML in code blocks rather than emitting it", () => {
    const html = markdownToHtml("```\n<script>alert(1)</script>\n```");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("renders tables, headings with anchors, and links", () => {
    const html = markdownToHtml("## The header\n\n| a | b |\n|---|---|\n| 1 | 2 |\n");
    expect(html).toContain('<h2 id="the-header">');
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<td>2</td>");
    expect(markdownToHtml("[x](y.html)")).toContain('<a href="y.html">x</a>');
  });

  it("renders a blockquote as a blockquote", () => {
    // The scope warning is the only blockquote thicket emits, and it is the
    // one block a reader must not miss.
    expect(markdownToHtml("> **warning** text")).toContain("<blockquote>");
  });
});
