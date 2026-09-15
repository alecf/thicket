/**
 * Builds the GitHub Pages site into `site/dist`.
 *
 * No dependencies, on purpose. This repository ships a CLI whose only runtime
 * dependency is `typescript`; adding a framework and a second lockfile to
 * publish four pages would be the largest thing in the tree. The Markdown
 * subset below is the subset the pages actually use, and `site/build.test.ts`
 * pins the parts that are easy to get wrong.
 *
 * Two of the pages are generated from files that live outside `site/`:
 *
 * - `report-guide.md` is copied VERBATIM from `docs/report-guide.md`, because
 *   the report itself links to it and an agent fetching that URL must get
 *   Markdown, not HTML.
 * - the example report is `tests/golden/sample-report.md`, the same bytes the
 *   test suite pins. The site therefore cannot show an example the tool would
 *   not produce.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const dist = join(here, "dist");

/** Escape for use in HTML text or an attribute. */
function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Inline Markdown: code, bold, italic, links. Code spans are extracted first
 * and restored last, so `**` inside a code span is not read as emphasis --
 * which matters here, because the guide is full of code spans containing
 * Markdown punctuation.
 */
function inline(text) {
  const spans = [];
  // Delimited by an escape that cannot occur in the source Markdown. The
  // placeholder used to be space-padded, which put a space back on restore:
  // every "`node:sqlite`." in the guide rendered as "node:sqlite ." on the
  // published page.
  let out = text.replace(/`([^`]+)`/g, (_, code) => {
    spans.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000${spans.length - 1}\u0000`;
  });
  out = escapeHtml(out);
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => `<a href="${href}">${label}</a>`);
  out = out.replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, '<a href="$1">$1</a>');
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => spans[Number(i)]);
}

function slug(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * The Markdown subset the site uses: headings, paragraphs, fenced code, bullet
 * and numbered lists, tables, blockquotes, horizontal rules.
 *
 * A fence is tracked with its own opening length so that a ```` ```` fence
 * containing ``` blocks -- which the README and the guide both use -- closes in
 * the right place rather than at the first inner fence.
 */
export function markdownToHtml(markdown) {
  const lines = markdown.split("\n");
  const out = [];
  let i = 0;
  const closeList = (stack) => {
    while (stack.length > 0) out.push(`</${stack.pop()}>`);
  };
  const listStack = [];

  while (i < lines.length) {
    const line = lines[i];

    const fence = /^(`{3,})(\w*)\s*$/.exec(line);
    if (fence) {
      closeList(listStack);
      const [, ticks, lang] = fence;
      const body = [];
      i += 1;
      while (i < lines.length && !new RegExp(`^\`{${ticks.length},}\\s*$`).test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1;
      const cls = lang ? ` class="language-${lang}"` : "";
      // Mermaid blocks are handed to the browser as-is; everything else is
      // escaped source.
      if (lang === "mermaid") out.push(`<pre class="mermaid">${escapeHtml(body.join("\n"))}</pre>`);
      else out.push(`<pre><code${cls}>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeList(listStack);
      const level = heading[1].length;
      const text = heading[2];
      out.push(`<h${level} id="${slug(text)}">${inline(text)}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^(---|\*\*\*)\s*$/.test(line)) {
      closeList(listStack);
      out.push("<hr>");
      i += 1;
      continue;
    }

    // A table: a header row, a delimiter row of dashes, then body rows.
    if (line.startsWith("|") && /^\|[\s:|-]+\|$/.test(lines[i + 1] ?? "")) {
      closeList(listStack);
      const cells = (row) =>
        row
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const body = [];
      while (i < lines.length && lines[i].startsWith("|")) {
        body.push(cells(lines[i]));
        i += 1;
      }
      out.push("<table><thead><tr>");
      for (const c of head) out.push(`<th>${inline(c)}</th>`);
      out.push("</tr></thead><tbody>");
      for (const row of body) {
        out.push("<tr>");
        for (const c of row) out.push(`<td>${inline(c)}</td>`);
        out.push("</tr>");
      }
      out.push("</tbody></table>");
      continue;
    }

    const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);
    const numbered = /^(\s*)\d+\.\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const match = bullet ?? numbered;
      const tag = bullet ? "ul" : "ol";
      const depth = Math.floor(match[1].length / 2);
      while (listStack.length > depth + 1) out.push(`</${listStack.pop()}>`);
      if (listStack.length < depth + 1) {
        out.push(`<${tag}>`);
        listStack.push(tag);
      }
      out.push(`<li>${inline(match[2])}</li>`);
      i += 1;
      continue;
    }

    if (line.startsWith(">")) {
      closeList(listStack);
      const quote = [];
      while (i < lines.length && lines[i].startsWith(">")) {
        quote.push(lines[i].replace(/^>\s?/, ""));
        i += 1;
      }
      out.push(`<blockquote>${markdownToHtml(quote.join("\n"))}</blockquote>`);
      continue;
    }

    if (line.trim() === "") {
      closeList(listStack);
      i += 1;
      continue;
    }

    // A paragraph runs to the next blank line or block-level construct.
    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(#{1,6}\s|\s*[-*]\s|\s*\d+\.\s|>|`{3,}|---|\|)/.test(lines[i])
    ) {
      para.push(lines[i]);
      i += 1;
    }
    if (para.length > 0) out.push(`<p>${inline(para.join(" "))}</p>`);
    else i += 1;
  }
  closeList(listStack);
  return out.join("\n");
}

const CSS = readFileSync(join(here, "style.css"), "utf8");

/** Wrap rendered body HTML in the site chrome. */
function page({ title, description, body, mermaid = false, active = "" }) {
  const nav = [
    ["", "Overview"],
    ["report-guide.html", "Report guide"],
    ["example.html", "Example report"],
  ]
    .map(([href, label]) => {
      const current = href === active ? ' aria-current="page"' : "";
      return `<a href="${href === "" ? "./" : href}"${current}>${label}</a>`;
    })
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="icon" href="icon.svg" type="image/svg+xml">
<style>${CSS}</style>
</head>
<body>
<header class="site">
  <a class="brand" href="./"><img src="icon.svg" alt="" width="28" height="28"><span>underbrush</span></a>
  <nav>${nav}</nav>
  <a class="gh" href="https://github.com/alecf/underbrush">GitHub</a>
</header>
<main>
${body}
</main>
<footer class="site">
  <p>Underbrush is a CLI that reports candidates. Something else does the judging and the editing.</p>
  <p><a href="https://github.com/alecf/underbrush">Source on GitHub</a> · <a href="report-guide.md">Report guide as raw Markdown</a></p>
</footer>
${mermaid ? '<script type="module">import m from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";m.initialize({startOnLoad:true,theme:"neutral"});</script>' : ""}
</body>
</html>
`;
}

export function build() {
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });

  const guideMarkdown = readFileSync(join(repo, "docs/report-guide.md"), "utf8");
  const exampleMarkdown = readFileSync(join(repo, "tests/golden/sample-report.md"), "utf8");

  // Verbatim, and this is load-bearing: every report underbrush emits links to
  // this exact URL, and the reader on the other end is a model that expects
  // Markdown.
  writeFileSync(join(dist, "report-guide.md"), guideMarkdown);

  writeFileSync(
    join(dist, "report-guide.html"),
    page({
      title: "How to read an underbrush report",
      description: "Field-by-field guide to an underbrush report, for agents and humans.",
      body: `<article class="prose">${markdownToHtml(guideMarkdown)}</article>`,
      active: "report-guide.html",
    }),
  );

  writeFileSync(
    join(dist, "example.html"),
    page({
      title: "Example underbrush report",
      description: "A complete underbrush report over a small fixture project.",
      body: `<article class="prose">
<h1 id="example-report">Example report</h1>
<p>This is a complete report over a four-file fixture, rendered exactly as underbrush emits it. It is the same file the test suite pins byte for byte, so nothing here is an illustration of output the tool would not produce.</p>
<hr>
${markdownToHtml(exampleMarkdown)}
</article>`,
      mermaid: true,
      active: "example.html",
    }),
  );

  writeFileSync(
    join(dist, "index.html"),
    page({
      title: "underbrush — find what is tangled in a TypeScript codebase",
      description:
        "A CLI that reports duplication and dependency cycles as a deterministic plaintext report, for an agent to act on.",
      body: readFileSync(join(here, "index.html.part"), "utf8"),
    }),
  );

  cpSync(join(here, "icon.svg"), join(dist, "icon.svg"));

  // A .nojekyll file stops GitHub Pages running the output through Jekyll,
  // which would otherwise ignore files and directories beginning with an
  // underscore.
  writeFileSync(join(dist, ".nojekyll"), "");

  return ["index.html", "report-guide.html", "report-guide.md", "example.html", "icon.svg"];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = build();
  console.log(`built site/dist: ${files.join(", ")}`);
}
