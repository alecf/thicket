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

  it("restores a code span without injecting spaces around it", () => {
    // The placeholder used to be space-padded, and the padding came back out
    // on restore: every "`node:sqlite`." in the guide published as
    // "node:sqlite ." — visible on the rendered page, invisible in the source.
    const html = markdownToHtml("the built-in `node:sqlite`, and `--config` at each path.");
    expect(html).toContain("<code>node:sqlite</code>,");
    expect(html).toContain("<code>--config</code> at each");
    expect(html).not.toMatch(/<\/code>\s[.,]/);
  });

  it("leaves no placeholder delimiter in the output", () => {
    const html = markdownToHtml("a `span` and `another` one");
    expect(html).not.toContain(String.fromCharCode(0));
    expect(html).toContain("<code>span</code> and <code>another</code>");
  });

  it("renders a blockquote as a blockquote", () => {
    // The scope warning is the only blockquote thicket emits, and it is the
    // one block a reader must not miss.
    expect(markdownToHtml("> **warning** text")).toContain("<blockquote>");
  });
});

/**
 * The site and the README both tell a newcomer how to install thicket, and
 * they drifted the moment one of them was updated: the README moved to `brew`
 * while the landing page still said `npm run build && node dist/cli.js` --
 * naming a file the build had stopped producing entirely. Neither page is
 * generated from the other, so nothing failed.
 */
describe("install instructions", () => {
  const readme = readFileSync(join(repo, "README.md"), "utf8");
  const landing = read("index.html");

  it("agrees with the README on the install command", () => {
    const fromReadme = /brew install (\S+)/.exec(readme)?.[1];
    const fromSite = /brew install (\S+)/.exec(landing)?.[1];
    expect(fromReadme).toBe("alecf/tap/thicket");
    expect(fromSite).toBe(fromReadme);
  });

  it("does not tell anyone to run a file the build no longer emits", () => {
    // `bun run build` compiles a binary now; there is no dist/cli.js to run.
    for (const page of ["index.html", "report-guide.html"]) {
      expect(read(page)).not.toContain("dist/cli.js");
    }
    expect(readme).not.toContain("dist/cli.js");
  });

  it("says the download is a directory, which is the part people get wrong", () => {
    // Copying the binary out on its own produces a tsgo panic about being
    // misplaced, and nothing else on the page would explain why.
    expect(landing).toContain("tsgo/");
  });
});

/**
 * The README and the landing page both tell a reader what to type, and neither
 * is generated from the CLI. They drifted: workspace discovery, `--filter`,
 * `--exclude`, `--types` and the bare-directory form shipped, and the README
 * went on documenting `--config` as the only way in -- and went on saying, in
 * Known limits, that there is no "point it at a directory" mode. Nothing
 * failed, because prose cannot fail.
 *
 * The check runs in both directions on purpose. A flag the docs invent is the
 * obvious drift; a flag the docs never mention is the one that actually
 * happened, and only the second direction catches it.
 */
describe("documented flags", () => {
  const cli = readFileSync(join(repo, "src/cli.ts"), "utf8");
  const readme = readFileSync(join(repo, "README.md"), "utf8");
  const landing = readFileSync(join(repo, "site/index.html.part"), "utf8");

  /** The `parseArgs` option table: the only thing that decides what is accepted. */
  const options = /options: \{([\s\S]*?)\n {6}\},/.exec(cli)?.[1] ?? "";
  const declared = [...options.matchAll(/^\s+"?([a-z][a-z-]*)"?:\s*\{\s*type:\s*"(\w+)"/gm)].map(
    (m) => ({ name: m[1] ?? "", boolean: m[2] === "boolean" }),
  );

  /** `--no-x` is accepted for every boolean, because parseArgs runs with allowNegative. */
  const accepted = new Set(
    declared.flatMap(({ name, boolean }) =>
      boolean ? [`--${name}`, `--no-${name}`] : [`--${name}`],
    ),
  );

  /** Flags named in the README's flag table, which is where a reader looks. */
  const documented = new Set(
    [...readme.matchAll(/^\| `(--[a-z][a-z-]*)[^`]*`/gm)].map((m) => m[1] ?? ""),
  );

  it("finds the CLI's option table at all", () => {
    // Every assertion below compares against `declared`; a regex that stopped
    // matching would empty it and turn all of them green.
    expect(declared.map(({ name }) => name)).toContain("filter");
    expect(declared.length).toBeGreaterThan(10);
    expect(documented.size).toBeGreaterThan(10);
  });

  it("documents every flag the CLI accepts", () => {
    // In either polarity: `cache` is documented as `--no-cache`, which is the
    // form anyone types.
    const missing = declared
      .map(({ name }) => name)
      .filter((name) => !documented.has(`--${name}`) && !documented.has(`--no-${name}`));
    expect(missing).toEqual([]);
  });

  it("documents no flag the CLI would reject", () => {
    expect([...documented].filter((flag) => !accepted.has(flag))).toEqual([]);
  });

  it("types only real flags in its worked examples", () => {
    // Prose mentions flags that deliberately do not exist ("no `--write`"), so
    // this reads the command blocks only -- the lines a reader copies.
    const commands = [
      ...[...readme.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1] ?? ""),
      ...[...landing.matchAll(/<code class="language-bash">([\s\S]*?)<\/code>/g)].map(
        (m) => m[1] ?? "",
      ),
    ];
    expect(commands.length).toBeGreaterThan(4);
    const used = new Set(commands.flatMap((body) => body.match(/--[a-z][a-z-]*/g) ?? []));
    expect(used.has("--config")).toBe(true);
    expect([...used].filter((flag) => !accepted.has(flag))).toEqual([]);
  });
});
