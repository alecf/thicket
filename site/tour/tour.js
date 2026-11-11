/*
 * The pipeline tour.
 *
 * One SVG world holds every stage of a thicket run, laid out left to right.
 * A camera moves across it. Everything on screen is a pure function of one
 * number, the time `t` in beats, so scrolling, playing and scrubbing all agree
 * and the animation runs backwards as well as forwards.
 *
 * The data comes from `data.js`, which `generate.ts` writes from a real run of
 * thicket over `site/tour/sample`. Nothing here invents a hash or a score.
 */
(() => {
  "use strict";
  const D = window.TOUR_DATA;
  const root = document.getElementById("tour");
  if (!D || !root) return;

  // ---------------------------------------------------------------- math --
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  const lin = (t, a, b) => clamp((t - a) / (b - a));
  const prog = (t, a, b) => ease(lin(t, a, b));
  const mix = (a, b, k) => a + (b - a) * k;
  const fmt = (n, d = 1) => n.toFixed(d);

  /** Eased interpolation through keyframes `[[time, {k: number}], ...]`. */
  function track(t, keys) {
    if (t <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++) {
      const [t1, v1] = keys[i];
      if (t <= t1) {
        const [t0, v0] = keys[i - 1];
        const k = t1 === t0 ? 1 : ease((t - t0) / (t1 - t0));
        const out = {};
        for (const key in v1) out[key] = mix(v0[key], v1[key], k);
        return out;
      }
    }
    return keys[keys.length - 1][1];
  }

  /** Deterministic stand-in characters while a hash "computes". */
  function scramble(target, k, seed) {
    const n = Math.floor(clamp(k) * target.length);
    let out = target.slice(0, n);
    for (let i = n; i < target.length; i++) {
      const h = Math.imul((seed + i * 7919) ^ 0x9e3779b9, 2654435761) >>> 0;
      out += "0123456789abcdef"[h % 16];
    }
    return out;
  }

  // ------------------------------------------------------------------ svg --
  const NS = "http://www.w3.org/2000/svg";
  function svg(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function label(parent, x, y, str, cls, attrs) {
    const e = svg("text", { x, y, class: cls || "", ...(attrs || {}) }, parent);
    e.textContent = str;
    return e;
  }
  // Writes only what changed. Most elements hold still in most frames.
  function attr(e, name, value) {
    const key = "_a" + name;
    if (e[key] !== value) {
      e.setAttribute(name, value);
      e[key] = value;
    }
  }
  function txt(e, value) {
    if (e._t !== value) {
      e.textContent = value;
      e._t = value;
    }
  }
  function cls(e, name, on) {
    on = !!on;
    const key = "_c" + name;
    if (e[key] !== on) {
      e.classList.toggle(name, on);
      e[key] = on;
    }
  }
  function put(e, x, y, s = 1, o = 1, sy) {
    const tr = `translate(${fmt(x)},${fmt(y)}) scale(${fmt(s, 3)}${sy === undefined ? "" : "," + fmt(sy, 3)})`;
    attr(e, "transform", tr);
    show(e, o);
  }
  function show(e, o) {
    const v = o < 0.01 ? "0" : fmt(Math.min(1, o), 3);
    if (e._o !== v) {
      e.style.opacity = v;
      e.style.display = v === "0" ? "none" : "";
      e._o = v;
    }
  }

  // ------------------------------------------------------------- timeline --
  const CHAPTERS = [
    { id: "read", title: "Read the code", t0: 0, t1: 8 },
    { id: "tree", title: "Build the syntax tree", t0: 8, t1: 22 },
    { id: "fingerprint", title: "Fingerprint a fragment", t0: 22, t1: 36 },
    { id: "fragments", title: "Cut every file", t0: 36, t1: 44 },
    { id: "index", title: "File by fingerprint", t0: 44, t1: 60 },
    { id: "nested", title: "Drop nested repeats", t0: 60, t1: 68 },
    { id: "near", title: "Catch the near copy", t0: 68, t1: 78 },
    { id: "rank", title: "Rank the findings", t0: 78, t1: 92 },
    { id: "imports", title: "Trace the imports", t0: 92, t1: 106 },
    { id: "report", title: "Write the report", t0: 106, t1: 120 },
  ];
  const T_END = 120;

  // ----------------------------------------------------------------- data --
  const FIELD_ALIAS = {
    FirstStatement: "VariableStatement",
    FirstLiteralToken: "NumericLiteral",
    FirstCompoundAssignment: "PlusEqualsToken",
  };
  const kindName = (k) => FIELD_ALIAS[k] || k;
  // Shorter kind names for the tree and the token rows, which are drawn at a
  // size where the full names would not fit. The caption says so.
  const ABBR = {
    FunctionDeclaration: "FunctionDecl",
    VariableStatement: "VarStatement",
    VariableDeclarationList: "VarDeclList",
    VariableDeclaration: "VarDecl",
    PropertyAccessExpression: "PropAccess",
    PropertySignature: "PropSignature",
    ExpressionStatement: "ExprStatement",
    BinaryExpression: "Binary",
    ForOfStatement: "ForOf",
    TypeReference: "TypeRef",
    ReturnStatement: "Return",
    PlusEqualsToken: "PlusEquals",
    AsteriskToken: "Asterisk",
  };
  const abbr = (k) => ABBR[kindName(k)] || kindName(k);
  const SHORT = {
    FunctionDeclaration: "function",
    Block: "block",
    ArrayLiteralExpression: "array",
    InterfaceDeclaration: "interface",
    ForOfStatement: "for…of",
    VariableDeclaration: "declaration",
    VariableDeclarationList: "declarations",
    FirstStatement: "const",
    ArrowFunction: "arrow fn",
    CallExpression: "call",
    ExpressionStatement: "statement",
    ObjectLiteralExpression: "object",
  };
  const short = (k) => SHORT[k] || kindName(k);
  const base = (p) => p.split("/").slice(-2).join("/");

  const files = new Map(
    D.files.map((f) => {
      const lines = f.text.replace(/\n$/, "").split("\n");
      const starts = [0];
      for (let i = 0; i < f.text.length; i++) if (f.text[i] === "\n") starts.push(i + 1);
      return [f.path, { path: f.path, text: f.text, lines, starts }];
    }),
  );
  const posOf = (file, offset) => {
    const s = file.starts;
    let line = 0;
    while (line + 1 < s.length && s[line + 1] <= offset) line++;
    return { line: line + 1, col: offset - s[line] };
  };

  const frags = D.fragments.map((f) => ({ ...f, eligible: f.literalShare <= 0.35 }));
  const fragByKey = new Map(frags.map((f) => [f.key, f]));

  const raw = D.rawClusters.map((c) => ({ ...c, members: c.members.map((k) => fragByKey.get(k)) }));
  const keptIds = new Set(D.keptClusters.map((c) => c.id));
  for (const c of raw) c.kept = keptIds.has(c.id);
  // Each dropped group goes into the kept group of its level whose copies
  // contain its copies.
  for (const c of raw) {
    if (c.kept) continue;
    c.parent = raw.find(
      (p) =>
        p.kept &&
        p.level === c.level &&
        c.members.every((m) => p.members.some((o) => o.file === m.file && o.start <= m.start && o.end >= m.end)),
    );
  }

  const json = D.report.json;
  const findings = [
    ...json.duplication.map((f) => ({ ...f, section: f.tag === "test" ? "tests" : "dup" })),
    ...json.typeDuplication.map((f) => ({ ...f, section: "types" })),
  ];
  const findingOf = new Map(findings.map((f) => [f.shapeHash, f]));
  for (const c of raw) c.finding = findingOf.get(c.id);

  const nearFinding = findings.find((f) => f.near && f.near.length);
  const nearOcc = nearFinding.near[0];
  const nearFrag = frags.find((f) => f.file === nearOcc.filePath && f.start === nearOcc.start && f.end === nearOcc.end);
  const nearGroup = raw.find((c) => c.finding === nearFinding);
  const cycle = json.cycles[0];
  const cut = cycle.cuts[0];

  // ---------------------------------------------------------------- world --
  const world = document.getElementById("world");
  const defs = svg("defs", null, world);
  const pattern = svg("pattern", { id: "dots", width: 28, height: 28, patternUnits: "userSpaceOnUse" }, defs);
  svg("circle", { cx: 1, cy: 1, r: 1.3, class: "dot" }, pattern);
  for (const name of ["ink", "cycle", "type", "soft"]) {
    const m = svg(
      "marker",
      { id: "arrow-" + name, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" },
      defs,
    );
    svg("path", { d: "M0,0 L10,5 L0,10 z", class: "arrowhead " + name }, m);
  }
  const bg = svg("rect", { x: -20000, y: -20000, width: 60000, height: 60000, fill: "url(#dots)", class: "bench" }, world);
  void bg;
  const layer = (name) => svg("g", { class: "layer " + name }, world);
  const L = {
    regions: layer("regions"),
    cards: layer("cards"),
    tree: layer("tree"),
    tokens: layer("tokens"),
    cells: layer("cells"),
    sketch: layer("sketch"),
    graph: layer("graph"),
    report: layer("report"),
    groups: layer("groups"),
    chips: layer("chips"),
  };

  // ---- cards ---------------------------------------------------------------
  const FS = 13;
  const CW = FS * 0.6;
  const LH = 19;
  const HDR = 40;
  const PADY = 14;
  const CARD_W = 560;
  const COL_STEP = 620;
  const COLS = [
    ["src/orders/total.ts", "src/orders/types.ts", "src/orders/total.test.ts"],
    ["src/invoice/total.ts"],
    ["src/reports/rows.ts"],
    ["src/cart/subtotal.ts", "src/cart/types.ts", "src/cart/subtotal.test.ts"],
  ];

  // Bracket nesting depth, per file, by containment.
  for (const f of frags) {
    f.depth = frags.filter(
      (o) =>
        o !== f &&
        o.file === f.file &&
        o.start <= f.start &&
        o.end >= f.end &&
        (o.start < f.start || o.end > f.end || o.nodes > f.nodes),
    ).length;
  }
  const maxDepth = Math.max(...frags.map((f) => f.depth));
  const BR = 5;
  const GUT = 10 + (maxDepth + 1) * BR + 30;

  const cards = new Map();
  let repoBottom = 0;
  COLS.forEach((col, c) => {
    let y = 0;
    for (const path of col) {
      const file = files.get(path);
      const h = HDR + PADY * 2 + file.lines.length * LH;
      cards.set(path, { file, x: c * COL_STEP, y, w: CARD_W, h, col: c });
      y += h + 34;
    }
    repoBottom = Math.max(repoBottom, y);
  });
  const REPO = { x: -50, y: -110, w: COLS.length * COL_STEP + 40, h: repoBottom + 150 };
  const lineTop = (card, n) => card.y + HDR + PADY + (n - 1) * LH;
  const charXY = (path, offset) => {
    const card = cards.get(path);
    const p = posOf(card.file, offset);
    return { x: card.x + GUT + p.col * CW, y: lineTop(card, p.line) + LH / 2 };
  };

  const KW = /\b(import|from|export|function|let|const|for|of|return|if|continue|interface|type|describe|it|expect)\b/;
  function codeLine(parent, x, y, src) {
    const t = svg("text", { x, y, class: "code" }, parent);
    t.setAttribute("xml:space", "preserve");
    const re = /("(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)|\b(import|from|export|function|let|const|for|of|return|if|continue|interface|type)\b|\b(\d+)\b/g;
    let last = 0;
    let m;
    while ((m = re.exec(src))) {
      if (m.index > last) svg("tspan", null, t).textContent = src.slice(last, m.index);
      const s = svg("tspan", { class: m[1] ? "str" : m[2] ? "kw" : "num" }, t);
      s.textContent = m[0];
      last = m.index + m[0].length;
    }
    if (last < src.length) svg("tspan", null, t).textContent = src.slice(last);
    return t;
  }
  void KW;

  const featuredPath = "src/orders/total.ts";
  const cardEls = new Map();
  for (const card of cards.values()) {
    const g = svg("g", { class: "card" }, L.cards);
    svg("rect", { x: card.x, y: card.y, width: card.w, height: card.h, rx: 10, class: "card-bg" }, g);
    const dir = card.file.path.split("/").slice(0, -1).join("/") + "/";
    const head = svg("text", { x: card.x + 18, y: card.y + 26, class: "card-path" }, g);
    svg("tspan", { class: "dir" }, head).textContent = dir;
    svg("tspan", null, head).textContent = card.file.path.split("/").pop();
    svg("line", { x1: card.x, x2: card.x + card.w, y1: card.y + HDR, y2: card.y + HDR, class: "card-rule" }, g);
    const band = svg("rect", { x: card.x + 1, width: card.w - 2, height: 0, y: 0, class: "line-band" }, g);
    card.file.lines.forEach((src, i) => {
      const y = lineTop(card, i + 1) + LH * 0.72;
      label(g, card.x + GUT - 12, y, String(i + 1), "lnum", { "text-anchor": "end" });
      codeLine(g, card.x + GUT, y, src);
    });
    const brackets = svg("g", { class: "brackets" }, g);
    cardEls.set(card.file.path, { g, band, brackets, card });
  }
  for (const f of frags) {
    const card = cards.get(f.file);
    const x = card.x + 10 + f.depth * BR;
    const y0 = lineTop(card, f.line) + 3;
    const y1 = lineTop(card, f.endLine) + LH - 3;
    f.bx = x;
    f.by = (y0 + y1) / 2;
    f.bracket = svg("path", { d: `M${x + 4},${y0} H${x} V${y1} H${x + 4}`, class: "bracket" }, cardEls.get(f.file).brackets);
  }

  // ---- syntax tree -----------------------------------------------------------
  const TREE_Y0 = repoBottom + 190;
  const DY = 64;
  const leafLabel = (n) => {
    if (n.text !== undefined) return n.text;
    if (n.kind === "ExportKeyword") return "export";
    if (n.kind === "FirstCompoundAssignment") return "+=";
    if (n.kind === "AsteriskToken") return "*";
    return abbr(n.kind);
  };
  const boxW = (s, size = 14) => s.length * size * 0.6 + 20;
  const treeNodes = [];
  (function walk(n, depth, parent) {
    n.depth = depth;
    n.parent = parent;
    n.leaf = n.children.length === 0;
    n.label = n.leaf ? leafLabel(n) : abbr(n.kind);
    n.role = n.text !== undefined ? (/^[0-9]/.test(n.text) ? "lit" : "id") : n.leaf ? "kw" : "kind";
    n.pre = treeNodes.length;
    treeNodes.push(n);
    for (const c of n.children) walk(c, depth + 1, n);
  })(D.tree, 0, null);
  const treeDepth = Math.max(...treeNodes.map((n) => n.depth));
  (function measure(n) {
    n.w = boxW(n.label);
    if (n.leaf) return (n.span = n.w + 12);
    const s = n.children.reduce((a, c) => a + measure(c), 0);
    return (n.span = Math.max(s, n.w + 12));
  })(D.tree);
  (function placeTree(n, x0) {
    n.ty = TREE_Y0 + n.depth * DY;
    if (n.leaf) {
      n.tx = x0 + n.span / 2;
      return;
    }
    const total = n.children.reduce((a, c) => a + c.span, 0);
    let x = x0 + (n.span - total) / 2;
    for (const c of n.children) {
      placeTree(c, x);
      x += c.span;
    }
    n.tx = (n.children[0].tx + n.children[n.children.length - 1].tx) / 2;
  })(D.tree, 0);
  const TREE = { x: -60, y: TREE_Y0 - 120, w: D.tree.span + 120, h: treeDepth * DY + 220 };
  for (const n of treeNodes) {
    const o = charXY(featuredPath, n.start);
    n.ox = o.x + Math.min(n.w, 80) / 2;
    n.oy = o.y;
    n.arrive = 11 + n.pre * 0.055 + 1.5;
    n.lines = n.endLine - n.line + 1;
  }
  const candidates = treeNodes.filter((n) => n.nodes >= D.minNodes);

  // ---- token rows -------------------------------------------------------------
  const alphaRename = (tokens) => {
    const seen = new Map();
    return tokens.map((t) => {
      if (!t.startsWith("Id:")) return t;
      const name = t.slice(3);
      if (!seen.has(name)) seen.set(name, seen.size);
      return "Id#" + seen.get(name);
    });
  };
  const tokDisplay = (t) => {
    if (t === "(" || t === ")") return t;
    if (t.startsWith("Id:")) return t.slice(3);
    if (t.startsWith("Id#")) return "#" + t.slice(3);
    const colon = t.indexOf(":");
    if (colon > 0) return t.slice(colon + 1);
    return abbr(t);
  };
  const tokRole = (t) => {
    if (t === "(" || t === ")") return "paren";
    if (t.startsWith("Id")) return "id";
    if (t.startsWith("FirstLiteralToken") || /Literal/.test(t)) return "lit";
    return "kind";
  };
  const streams = {
    a0: D.featured["src/orders/total.ts"].l0,
    b0: D.featured["src/cart/subtotal.ts"].l0,
    a1: alphaRename(D.featured["src/orders/total.ts"].l1),
    b1: alphaRename(D.featured["src/cart/subtotal.ts"].l1),
  };
  const TOK_X0 = 0;
  const TOK_W = 1260;
  const TOK_Y0 = TREE.y + TREE.h + 120;
  const TOK_H = 30;
  const tokens = [];
  {
    let x = TOK_X0;
    let row = 0;
    for (let i = 0; i < streams.a0.length; i++) {
      const texts = [streams.a0[i], streams.b0[i], streams.a1[i], streams.b1[i]].map(tokDisplay);
      const paren = streams.a0[i] === "(" || streams.a0[i] === ")";
      const w = paren ? 11 : Math.max(...texts.map((s) => s.length)) * 13 * 0.6 + 16;
      if (x + w > TOK_X0 + TOK_W) {
        x = TOK_X0;
        row++;
      }
      tokens.push({ i, x, w, row, paren, texts, role: tokRole(streams.a0[i]) });
      x += w + (paren ? 2 : 5);
    }
  }
  const tokRows = Math.max(...tokens.map((t) => t.row)) + 1;
  const PAIR = 100;
  for (const t of tokens) {
    t.ya = TOK_Y0 + t.row * PAIR;
    t.yb = t.ya + 40;
    t.diff = t.texts[0] !== t.texts[1];
  }
  // Which token each tree node becomes, in the order fragments.ts emits them.
  {
    let k = 0;
    (function emit(n) {
      n.tok = tokens[k++];
      for (const c of n.children) {
        k++;
        emit(c);
        k++;
      }
    })(D.tree);
  }
  const HASH_Y = TOK_Y0 + tokRows * PAIR + 40;
  const TOKENS = { x: -40, y: TOK_Y0 - 110, w: TOK_W + 80, h: tokRows * PAIR + 300 };

  // ---- index grid -------------------------------------------------------------
  const INDEX_X = REPO.x + REPO.w + 420;
  const INDEX_Y = -60;
  const CELL_W = 250;
  const CELL_H = 66;
  const CELL_GAP_X = 16;
  const CELL_GAP_Y = 40;
  const GRID_COLS = 5;
  const CHIP_W = 222;
  const CHIP_H = 46;
  // Stagger order: column by column, top to bottom, as the files sit.
  const fileOrder = COLS.flat();
  frags.sort((a, b) => fileOrder.indexOf(a.file) - fileOrder.indexOf(b.file) || a.start - b.start || b.end - a.end);
  frags.forEach((f, i) => (f.n = i));
  const assign = (keyOf) => {
    const keys = [...new Set(frags.map(keyOf))].sort();
    const slots = new Map();
    for (const f of frags) {
      const k = keyOf(f);
      const list = slots.get(k) || [];
      list.push(f);
      slots.set(k, list);
    }
    return { keys, slots };
  };
  const P0 = assign((f) => f.l0);
  const P1 = assign((f) => (f.eligible ? "1" + f.l1 : "0" + f.l0));
  const cellCount = Math.max(P0.keys.length, P1.keys.length);
  const cellXY = (i) => ({
    x: INDEX_X + (i % GRID_COLS) * (CELL_W + CELL_GAP_X),
    y: INDEX_Y + Math.floor(i / GRID_COLS) * (CELL_H + CELL_GAP_Y),
  });
  const INDEX = {
    x: INDEX_X - 50,
    y: INDEX_Y - 100,
    w: GRID_COLS * (CELL_W + CELL_GAP_X) + 80,
    h: Math.ceil(cellCount / GRID_COLS) * (CELL_H + CELL_GAP_Y) + 110,
  };
  for (const f of frags) {
    const k0 = P0.keys.indexOf(f.l0);
    const k1 = P1.keys.indexOf(f.eligible ? "1" + f.l1 : "0" + f.l0);
    const c0 = cellXY(k0);
    const c1 = cellXY(k1);
    const j0 = P0.slots.get(f.l0).indexOf(f);
    const j1 = P1.slots.get(f.eligible ? "1" + f.l1 : "0" + f.l0).indexOf(f);
    f.cell0 = { x: c0.x + 10 + j0 * 9, y: c0.y + 10 - j0 * 5 };
    f.cell1 = { x: c1.x + 10 + j1 * 9, y: c1.y + 10 - j1 * 5 };
    f.t0 = 45 + f.n * 0.13;
    f.t1 = 54 + f.n * 0.07;
    f.group0 = raw.find((c) => c.level === "L0" && c.members.includes(f));
    f.group1 = raw.find((c) => c.level === "L1" && c.members.includes(f));
  }
  const groupCell = (c) =>
    c.level === "L0" ? cellXY(P0.keys.indexOf(c.members[0].l0)) : cellXY(P1.keys.indexOf("1" + c.members[0].l1));

  // ---- groups -------------------------------------------------------------------
  const GROUPS_X = INDEX.x + INDEX.w + 300;
  const GROUP_W = 660;
  const MEMBER_H = 36;
  const order = [
    raw.find((c) => c.level === "L0" && c.kind === "FunctionDeclaration"),
    raw.find((c) => c.level === "L0" && c.kind === "Block"),
    raw.find((c) => c.level === "L0" && c.kind === "ArrayLiteralExpression"),
    raw.find((c) => c.level === "L1" && c.kind === "FunctionDeclaration"),
    raw.find((c) => c.level === "L1" && c.kind === "Block"),
    raw.find((c) => c.level === "L1" && c.kind === "InterfaceDeclaration"),
  ].filter(Boolean);
  for (const c of raw) if (!order.includes(c)) order.push(c);
  const groupH = (c, withNear) => 58 + (c.members.length + (withNear ? 1 : 0)) * MEMBER_H + 12;
  {
    let y = 0;
    for (const c of order) {
      c.gy0 = y;
      y += groupH(c, false) + 22;
    }
    const kept = order.filter((c) => c.kept);
    y = 0;
    for (const c of kept) {
      c.gy1 = y;
      y += groupH(c, c === nearGroup) + 22;
    }
    for (const c of order) if (!c.kept) c.gy1 = c.parent.gy1 + 14;
  }
  const GROUPS_H = order.reduce((a, c) => a + groupH(c, false) + 22, 0);
  const GROUPS = { x: GROUPS_X - 80, y: -120, w: GROUP_W + 160, h: GROUPS_H + 200 };
  for (const c of order) {
    const lastIn = (at) => Math.max(...c.members.map(at));
    c.spawn = (c.level === "L0" ? lastIn((f) => f.t0 + 1.5) : lastIn((f) => f.t1 + 1.2)) + 0.5;
    const cell = groupCell(c);
    c.cx = cell.x;
    c.cy = cell.y;
  }

  // ---- sketch -------------------------------------------------------------------
  const SK_X = GROUPS_X + GROUP_W + 220;
  const SK_CELL = 30;
  const SK_COLS = 16;
  const SK_Y_A = 40;
  const SK_Y_B = SK_Y_A + (D.sketchBins / SK_COLS) * SK_CELL + 150;
  const SKETCH = { x: SK_X - 60, y: SK_Y_A - 140, w: SK_COLS * SK_CELL + 300, h: SK_Y_B + 8 * SK_CELL + 260 };
  const bins = D.near.binsA.map((a, i) => {
    const b = D.near.binsB[i];
    const state = a < 0 && b < 0 ? "skip" : a === b ? "agree" : "differ";
    return { i, a, b, state, t: 70.4 + i * (3.8 / D.sketchBins) };
  });

  // ---- rank -----------------------------------------------------------------------
  const RANK_X = SKETCH.x + SKETCH.w + 360;
  const RANK_W = 1040;
  const RANK_ROW = 150;
  const LEVEL = { L0: 1, L1: 0.9 };
  const COUNT_EXP = { L0: 0.9, L1: 0.6 };
  // Scored in the order the report prints them: sections, then score.
  const SECTION_ORDER = ["dup", "types", "tests"];
  const kept = order
    .filter((c) => c.kept)
    .sort(
      (a, b) =>
        SECTION_ORDER.indexOf(a.finding.section) - SECTION_ORDER.indexOf(b.finding.section) ||
        b.finding.score - a.finding.score,
    );
  kept.forEach((c, i) => {
    const f = c.finding;
    const copies = c.members.length;
    const size = Math.pow(c.nodeCount, 1.5);
    const count = Math.pow(copies - 1, COUNT_EXP[c.level]);
    const factors = [
      { label: `${c.nodeCount} nodes ^ 1.5`, value: size, show: fmt(size) },
      {
        label: `(${copies} copies − 1) ^ ${COUNT_EXP[c.level]}`,
        value: count,
        show: "× " + fmt(count, 2),
      },
      { label: "copies in different modules", value: 2.5, show: "× 2.5" },
    ];
    if (c.level === "L1") factors.push({ label: "renamed, not exact", value: 0.9, show: "× 0.9" });
    if (f.tag === "test") factors.push({ label: "only test code", value: 0.4, show: "× 0.4" });
    let product = factors.reduce((a, x) => a * x.value, 1);
    if (Math.abs(product - f.score) / f.score > 0.01) {
      const drift = f.score / product;
      factors.push({ label: "field names differ (items, lines)", value: drift, show: "× " + fmt(drift, 2) });
      product *= drift;
    }
    c.factors = factors;
    c.score = f.score;
    c.rankStart = [79.4, 81.6, 86.2, 88.2][i] ?? 88 + i;
    c.rankStep = c.factors.length > 4 ? 0.85 : 0.5;
    c.ry0 = i * RANK_ROW;
  });
  // Sections, then score within a section, as the report prints them.
  const SECTIONS = [
    { id: "dup", title: "Duplication" },
    { id: "types", title: "Duplicated types" },
    { id: "tests", title: "Duplication in tests" },
  ];
  {
    let y = 0;
    for (const s of SECTIONS) {
      s.y = y;
      y += 62;
      const rows = kept.filter((c) => c.finding.section === s.id).sort((a, b) => b.score - a.score);
      rows.forEach((c, i) => {
        c.ry1 = y;
        c.place = i + 1;
        y += RANK_ROW;
      });
      y += 30;
    }
  }
  const maxPartial = Math.max(...kept.map((c) => c.factors.reduce((a, f, i) => (i < 3 ? a * f.value : a), 1)));
  const BAR_MAX = 640;
  const barScale = BAR_MAX / maxPartial;
  const RANK = { x: RANK_X - 80, y: -140, w: RANK_W + 160, h: 1100 };

  // ---- import graph -------------------------------------------------------------
  const GRAPH_X = RANK.x + RANK.w + 700;
  const NODE_POS = {
    "src/orders/total.test.ts": [0, 0],
    "src/orders/total.ts": [0, 300],
    "src/invoice/total.ts": [640, 300],
    "src/reports/rows.ts": [320, 600],
    "src/orders/types.ts": [320, 900],
    "src/cart/subtotal.test.ts": [1020, 0],
    "src/cart/subtotal.ts": [1020, 600],
    "src/cart/types.ts": [1020, 900],
  };
  const NODE_W = 300;
  const NODE_H = 58;
  const gnodes = new Map(
    Object.entries(NODE_POS).map(([p, [x, y]]) => [p, { path: p, x: GRAPH_X + x, y: 60 + y }]),
  );
  const importNames = (fromPath, toPath) => {
    const src = files.get(fromPath).text;
    const dir = fromPath.split("/").slice(0, -1);
    for (const m of src.matchAll(/import (type )?\{([^}]*)\} from "([^"]+)"/g)) {
      const parts = [...dir];
      for (const seg of m[3].split("/")) {
        if (seg === "..") parts.pop();
        else if (seg !== ".") parts.push(seg);
      }
      if (parts.join("/").replace(/\.js$/, ".ts") === toPath) return (m[1] ? "type " : "") + "{" + m[2] + "}";
    }
    return "";
  };
  const inCycle = new Set(cycle.modules);
  const gedges = [];
  for (const { file, targets } of D.imports) {
    for (const t of targets) {
      const typeOnly = t.symbols > 0 && t.erased === t.symbols;
      const ring = inCycle.has(file) && inCycle.has(t.target) && !typeOnly;
      gedges.push({
        from: file,
        to: t.target,
        typeOnly,
        ring,
        cut: file === cut.from && t.target === cut.to,
        names: importNames(file, t.target).replace(/\s+/g, " "),
      });
    }
  }
  const BEND = {
    "src/orders/total.ts>src/orders/types.ts": 90,
    "src/invoice/total.ts>src/orders/types.ts": -90,
  };
  gedges.forEach((e, i) => (e.t = 93 + i * 0.55));
  const GRAPH = { x: GRAPH_X - 230, y: -80, w: 1500, h: 1140 };

  // ---- report -----------------------------------------------------------------------
  const REPORT_X = GRAPH.x + GRAPH.w + 500;
  const RLH = 26;
  const RFS = 15;
  const reportLines = [];
  {
    let fence = false;
    for (const line of D.report.markdown.replace(/\n$/, "").split("\n")) {
      if (line.startsWith("```")) fence = !fence;
      let cls = fence || line.startsWith("```") ? "r-code" : "r-text";
      if (/^#{1,2} /.test(line)) cls = "r-h1";
      else if (line.startsWith("### ")) cls = "r-h3";
      else if (line.startsWith("|")) cls = "r-table";
      else if (line.startsWith("- ")) cls = "r-bullet";
      const max = 104;
      reportLines.push({ text: line.length > max ? line.slice(0, max - 1) + "…" : line, cls });
    }
  }
  const PAPER_W = 104 * RFS * 0.6 + 120;
  const PAPER_H = reportLines.length * RLH + 120;
  const PAPER = { x: REPORT_X, y: 0, w: PAPER_W, h: PAPER_H };
  const reportStart = 107;
  const reportSpan = 10.5;
  reportLines.forEach((r, i) => {
    r.t = reportStart + (i / reportLines.length) * reportSpan;
    r.y = PAPER.y + 70 + i * RLH;
  });
  const findLine = (re) => reportLines.findIndex((r) => re.test(r.text));

  // --------------------------------------------------------------- build DOM --
  // Region labels on the bench, so a reader who zooms out can see the line.
  const REGION_LABELS = [
    [REPO, "Source files"],
    [INDEX, "Fingerprint index"],
    [GROUPS, "Groups"],
    [SKETCH, "Sketches"],
    [RANK, "Ranking"],
    [GRAPH, "Import graph"],
    [PAPER, "Report"],
  ];
  for (const [r, name] of REGION_LABELS) label(L.regions, r.x + 50, r.y + 40, name, "region-label");

  // Tree
  const treeEdges = [];
  for (const n of treeNodes) {
    if (n.parent) {
      const line = svg("line", { class: "tree-edge" }, L.tree);
      treeEdges.push({ n, line });
    }
  }
  for (const n of treeNodes) {
    const g = svg("g", { class: "tnode role-" + n.role }, L.tree);
    n.rect = svg("rect", { x: -n.w / 2, y: -15, width: n.w, height: 30, rx: 7 }, g);
    n.text = label(g, 0, 5, n.label, "tlabel", { "text-anchor": "middle" });
    n.g = g;
    if (!n.leaf) {
      const badge = svg("g", { class: "count" }, g);
      svg("circle", { cx: n.w / 2 + 4, cy: -15, r: 13 }, badge);
      label(badge, n.w / 2 + 4, -10.5, String(n.nodes), "count-n", { "text-anchor": "middle" });
      n.badge = badge;
    }
  }
  const verdicts = candidates.map((n) => {
    const ok = n.lines >= D.minLines;
    const g = svg("g", { class: "verdict " + (ok ? "ok" : "no") }, L.tree);
    const msg = `${n.nodes} nodes · ${n.lines} line${n.lines === 1 ? "" : "s"} ${ok ? "✓ fragment" : "✗ too short"}`;
    const w = boxW(msg, 13);
    svg("rect", { x: -w / 2, y: -14, width: w, height: 28, rx: 14 }, g);
    label(g, 0, 5, msg, "verdict-t", { "text-anchor": "middle" });
    return { n, ok, g, w };
  });

  // Tokens
  const tokEls = tokens.map((t) => {
    const mk = (row) => {
      const g = svg("g", { class: "tok role-" + t.role + (t.paren ? " paren" : "") + " " + row }, L.tokens);
      const r = t.paren ? null : svg("rect", { x: 0, y: -TOK_H / 2, width: t.w, height: TOK_H, rx: 6 }, g);
      const s = label(g, t.w / 2, 4.5, "", "tok-t", { "text-anchor": "middle" });
      const u = svg("line", { x1: 3, x2: t.w - 3, y1: TOK_H / 2 + 4, y2: TOK_H / 2 + 4, class: "diff-mark" }, g);
      return { g, r, s, u };
    };
    return { t, a: t.paren ? mk("a") : null, b: mk("b") };
  });
  // Paren tokens in the orders row are separate; node tokens are the tree nodes.
  const rowLabels = [
    label(L.tokens, TOK_X0, TOK_Y0 - 62, "src/orders/total.ts · orderTotal", "row-label a"),
    label(L.tokens, TOK_X0 + 520, TOK_Y0 - 62, "src/cart/subtotal.ts · cartSubtotal", "row-label b"),
  ];
  const hashPanel = svg("g", { class: "hash-panel" }, L.tokens);
  const hp = (y, who) => {
    const g = svg("g", { class: "hp " + who }, hashPanel);
    label(g, 0, 0, who === "a" ? "orderTotal" : "cartSubtotal", "hp-name");
    const l0 = label(g, 0, 38, "", "hp-hash l0");
    const l1 = label(g, 0, 78, "", "hp-hash l1");
    label(g, -6, 38, "L0", "hp-level", { "text-anchor": "end" });
    label(g, -6, 78, "L1", "hp-level", { "text-anchor": "end" });
    put(g, who === "a" ? TOK_X0 + 40 : TOK_X0 + 560, y);
    return { g, l0, l1 };
  };
  const hpa = hp(HASH_Y, "a");
  const hpb = hp(HASH_Y, "b");
  const sameMark = label(hashPanel, TOK_X0 + 1000, HASH_Y + 78, "same L1 ✓", "same-mark");
  const hashOf = (path, level) => frags.find((f) => f.file === path && f.kind === "FunctionDeclaration")[level];

  // Index cells
  const cells = [];
  for (let i = 0; i < cellCount; i++) {
    const { x, y } = cellXY(i);
    const g = svg("g", { class: "cell" }, L.cells);
    const r = svg("rect", { x, y, width: CELL_W, height: CELL_H, rx: 10 }, g);
    const k0 = P0.keys[i];
    const k1 = P1.keys[i];
    const l0 = label(g, x + 4, y - 10, k0 ? k0 : "", "cell-key");
    const l1 = label(g, x + 4, y - 10, k1 ? k1.slice(1) : "", "cell-key");
    const c0 = k0 ? P0.slots.get(k0).length : 0;
    const c1 = k1 ? P1.slots.get(k1).length : 0;
    const b0 = label(g, x + CELL_W - 4, y - 10, c0 > 1 ? `${c0} copies` : "", "cell-count", { "text-anchor": "end" });
    const b1 = label(g, x + CELL_W - 4, y - 10, c1 > 1 ? `${c1} copies` : "", "cell-count", { "text-anchor": "end" });
    const n0 = k0 ? P0.slots.get(k0).length : 0;
    const n1 = k1 ? P1.slots.get(k1).length : 0;
    const g1 = k1 && k1[0] === "1" && raw.some((c) => c.level === "L1" && c.members[0].l1 === k1.slice(1));
    const g0 = k1 && k1[0] === "0" && n1 > 1;
    const ring = svg("rect", { x: -CELL_W / 2, y: -CELL_H / 2, width: CELL_W, height: CELL_H, rx: 12, class: "cell-ring" }, L.cells);
    // A slot lights up when its last fragment lands.
    const lastIn = (list, at) => Math.max(...list.map((f) => at(f)));
    const hit0 = n0 > 1 ? lastIn(P0.slots.get(k0), (f) => f.t0 + 1.5) : null;
    const hit1 = g1 || g0 ? lastIn(P1.slots.get(k1), (f) => f.t1 + 1.2) : null;
    cells.push({ g, r, l0, l1, b0, b1, n0, n1, k0, k1, g1, g0, has0: !!k0, has1: !!k1, ring, hit0, hit1, cx: x + CELL_W / 2, cy: y + CELL_H / 2 });
  }

  // Chips
  for (const f of frags) {
    const g = svg("g", { class: "chip", tabindex: "-1" }, L.chips);
    f.chipRect = svg("rect", { x: 0, y: 0, width: CHIP_W, height: CHIP_H, rx: 8 }, g);
    label(g, 10, 19, `${base(f.file)}:${f.line}`, "chip-t");
    f.chipTag = label(g, 10, 37, short(f.kind), "chip-tag");
    f.chipHash = label(g, CHIP_W - 10, 37, "", "chip-h", { "text-anchor": "end" });
    f.chip = g;
    g.addEventListener("click", () => follow(f.key, true));
  }

  // Groups, which become ranked findings
  for (const c of order) {
    const g = svg("g", { class: "group lvl-" + c.level }, L.groups);
    c.g = g;
    c.bg = svg("rect", { x: 0, y: 0, width: GROUP_W, height: groupH(c), rx: 12, class: "group-bg" }, g);
    c.stripe = svg("rect", { x: 0, y: 0, width: 8, height: groupH(c), rx: 4, class: "group-stripe" }, g);
    const pill = svg("g", { class: "lvl-pill" }, g);
    svg("rect", { x: 24, y: 16, width: 40, height: 26, rx: 13 }, pill);
    label(pill, 44, 34, c.level, "lvl-t", { "text-anchor": "middle" });
    c.title = label(g, 78, 35, `${kindName(c.kind)} · ${c.nodeCount} nodes · ${c.members.length} copies`, "group-title");
    c.membersG = svg("g", null, g);
    c.memberRows = c.members.map((m, i) => {
      const y = 58 + i * MEMBER_H;
      const row = svg("g", { class: "member" }, c.membersG);
      svg("rect", { x: 24, y, width: GROUP_W - 48, height: MEMBER_H - 6, rx: 6 }, row);
      label(row, 38, y + 20, `${m.file}`, "member-t");
      label(row, GROUP_W - 38, y + 20, `lines ${m.line}–${m.endLine}`, "member-l", { "text-anchor": "end" });
      return { row, m };
    });
    if (c === nearGroup) {
      const y = 58 + c.members.length * MEMBER_H;
      const row = svg("g", { class: "member near" }, c.membersG);
      svg("rect", { x: 24, y, width: GROUP_W - 48, height: MEMBER_H - 6, rx: 6 }, row);
      label(row, 38, y + 20, nearFrag.file, "member-t");
      label(row, GROUP_W - 38, y + 20, `near copy · ${Math.round(nearOcc.similarity * 100)}%`, "member-l", {
        "text-anchor": "end",
      });
      c.nearRow = row;
    }
    if (!c.kept) c.inside = label(g, GROUP_W - 24, 35, "inside a bigger group", "inside-t", { "text-anchor": "end" });
    if (c.kept) {
      const rk = svg("g", { class: "rankpart" }, g);
      c.rankG = rk;
      c.place = c.place || 0;
      c.idLabel = label(rk, RANK_W - 30, 35, c.finding.id, "finding-id", { "text-anchor": "end" });
      c.factorEls = c.factors.map((f) => {
        const fg = svg("g", { class: "factor" + (f.value < 1 ? " down" : "") }, rk);
        const w1 = boxW(f.show, 15);
        const w2 = f.label.length * 12 * 0.6 + 8;
        const w = Math.max(w1, w2);
        svg("rect", { x: 0, y: 0, width: w, height: 30, rx: 7 }, fg);
        label(fg, w / 2, 21, f.show, "factor-v", { "text-anchor": "middle" });
        label(fg, w / 2, 48, f.label, "factor-l", { "text-anchor": "middle" });
        return { fg, w };
      });
      {
        let x = 24;
        for (const e of c.factorEls) {
          e.x = x;
          x += e.w + 14;
        }
      }
      c.bar = svg("rect", { x: 24, y: 112, width: 0, height: 18, rx: 4, class: "bar" }, rk);
      c.scoreT = label(rk, 0, 127, "", "score-t");
      c.placeT = label(g, -18, 40, "", "place-t", { "text-anchor": "end" });
    }
  }
  const sectionEls = SECTIONS.map((s) => {
    const t = label(L.groups, 0, 0, s.title, "section-t");
    return { s, t };
  });

  // Sketch
  const skEls = { a: [], b: [] };
  const skG = svg("g", { class: "sketch" }, L.sketch);
  label(skG, SK_X, SK_Y_A - 40, `sketch of orderTotal (${base(featuredPath)})`, "sk-label");
  label(skG, SK_X, SK_Y_B - 40, `sketch of reportTotal (${base(nearFrag.file)})`, "sk-label");
  const skMeter = label(skG, SK_X, SK_Y_B + 8 * SK_CELL + 70, "", "sk-meter");
  const skVerdict = label(skG, SK_X, SK_Y_B + 8 * SK_CELL + 120, "", "sk-verdict");
  for (const b of bins) {
    for (const side of ["a", "b"]) {
      const v = b[side];
      const x = SK_X + (b.i % SK_COLS) * SK_CELL;
      const y = (side === "a" ? SK_Y_A : SK_Y_B) + Math.floor(b.i / SK_COLS) * SK_CELL;
      const r = svg("rect", {
        x: x + 2,
        y: y + 2,
        width: SK_CELL - 4,
        height: SK_CELL - 4,
        rx: 4,
        class: "bin" + (v < 0 ? " empty" : ""),
        ...(v < 0 ? {} : { "fill-opacity": fmt(0.18 + 0.7 * (v / 65535), 2) }),
      }, skG);
      skEls[side].push(r);
    }
  }
  const scan = svg("rect", { x: 0, y: SK_Y_A - 6, width: 4, height: SK_Y_B - SK_Y_A + 8 * SK_CELL + 12, rx: 2, class: "scan" }, skG);

  // Graph
  const gEdgeEls = gedges.map((e) => {
    const a = gnodes.get(e.from);
    const b = gnodes.get(e.to);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    const clip = (sx, sy) => Math.min(NODE_W / 2 / Math.abs(sx || 1e-9), NODE_H / 2 / Math.abs(sy || 1e-9));
    const ux = dx / len;
    const uy = dy / len;
    const ta = clip(ux, uy) + 6;
    const tb = clip(ux, uy) + 10;
    const x1 = a.x + ux * ta;
    const y1 = a.y + uy * ta;
    const x2 = b.x - ux * tb;
    const y2 = b.y - uy * tb;
    const bend = BEND[e.from + ">" + e.to] ?? (e.ring ? 40 : 0);
    const mx = (x1 + x2) / 2 - uy * bend;
    const my = (y1 + y2) / 2 + ux * bend;
    const g = svg("g", { class: "gedge" + (e.typeOnly ? " type" : "") + (e.ring ? " ring" : "") }, L.graph);
    const path = svg("path", {
      d: `M${fmt(x1)},${fmt(y1)} Q${fmt(mx)},${fmt(my)} ${fmt(x2)},${fmt(y2)}`,
      pathLength: 1,
      "stroke-dasharray": "1 1",
      "marker-end": `url(#arrow-${e.typeOnly ? "type" : "ink"})`,
    }, g);
    const lx = (x1 + 2 * mx + x2) / 4;
    const ly = (y1 + 2 * my + y2) / 4;
    const lw = e.names.length * 13 * 0.6 + 18;
    const lg = svg("g", { class: "elabel" }, g);
    svg("rect", { x: lx - lw / 2, y: ly - 14, width: lw, height: 26, rx: 6 }, lg);
    label(lg, lx, ly + 4, e.names, "elabel-t", { "text-anchor": "middle" });
    return { e, g, path, lg, x1, y1, mx, my, x2, y2 };
  });
  const ringIds = cycle.modules;
  const ringPts = ringIds.map((p) => gnodes.get(p));
  const hull = svg("path", {
    d: "M" + ringPts.map((p) => `${p.x},${p.y}`).join(" L") + " Z",
    class: "hull",
  }, L.graph);
  L.graph.insertBefore(hull, L.graph.firstChild);
  const gNodeEls = [...gnodes.values()].map((n) => {
    const g = svg("g", { class: "gnode" + (inCycle.has(n.path) ? " in-ring" : "") }, L.graph);
    svg("rect", { x: n.x - NODE_W / 2, y: n.y - NODE_H / 2, width: NODE_W, height: NODE_H, rx: 12 }, g);
    const t = svg("text", { x: n.x, y: n.y + 6, class: "gnode-t", "text-anchor": "middle" }, g);
    svg("tspan", { class: "dir" }, t).textContent = n.path.split("/").slice(0, -1).join("/") + "/";
    svg("tspan", null, t).textContent = n.path.split("/").pop();
    return { n, g };
  });
  const pulse = svg("circle", { r: 14, class: "pulse" }, L.graph);
  const ringEdgeEls = ringIds.map((p, i) =>
    gEdgeEls.find((x) => x.e.ring && x.e.from === ringIds[(i + 1) % ringIds.length] && x.e.to === p) ||
    gEdgeEls.find((x) => x.e.ring && x.e.from === p && x.e.to === ringIds[(i + 1) % ringIds.length]),
  );
  // Walk the ring in import order: follow each runtime edge to its target.
  const ringWalk = [];
  {
    let at = cycle.modules[0];
    for (let i = 0; i < cycle.modules.length; i++) {
      const next = gEdgeEls.find((x) => x.e.ring && x.e.from === at);
      if (!next) break;
      ringWalk.push(next);
      at = next.e.to;
    }
  }
  void ringEdgeEls;
  const cutEl = gEdgeEls.find((x) => x.e.cut);
  const cutNote = svg("g", { class: "cut-note" }, L.graph);
  {
    const x = (cutEl.x1 + cutEl.x2) / 2 + 120;
    const y = (cutEl.y1 + cutEl.y2) / 2 + 40;
    const lines = ["suggested cut", `${base(cut.from)} → ${base(cut.to)}`, `${cut.weight} symbol: ${cutEl.e.names}`, "leaves no cycle"];
    const w = Math.max(...lines.map((s) => s.length)) * 14 * 0.6 + 36;
    svg("rect", { x: x - 18, y: y - 30, width: w, height: lines.length * 26 + 22, rx: 10 }, cutNote);
    lines.forEach((s, i) => label(cutNote, x, y + i * 26, s, i === 0 ? "cut-h" : "cut-t"));
  }

  // Report
  const paper = svg("g", { class: "paper" }, L.report);
  svg("rect", { x: PAPER.x, y: PAPER.y, width: PAPER.w, height: PAPER.h, rx: 6, class: "paper-bg" }, paper);
  const reportEls = reportLines.map((r) => {
    const t = svg("text", { x: PAPER.x + 60, y: r.y, class: "rline " + r.cls }, paper);
    t.setAttribute("xml:space", "preserve");
    t.textContent = r.text;
    return t;
  });
  const caret = svg("rect", { width: 9, height: 18, class: "caret" }, paper);

  // --------------------------------------------------------------- camera --
  const union = (...rs) => {
    const x = Math.min(...rs.map((r) => r.x));
    const y = Math.min(...rs.map((r) => r.y));
    const x2 = Math.max(...rs.map((r) => r.x + r.w));
    const y2 = Math.max(...rs.map((r) => r.y + r.h));
    return { x, y, w: x2 - x, h: y2 - y };
  };
  const featCard = cards.get(featuredPath);
  const ZOOM_FN = { x: featCard.x - 30, y: featCard.y - 30, w: featCard.w + 60, h: featCard.h + 60 };
  const reportView = (k) => {
    const h = 34 * RLH;
    return { x: PAPER.x - 80, y: mix(PAPER.y - 60, PAPER.y + PAPER.h - h + 40, k), w: PAPER.w + 420, h };
  };
  const colsView = (a, b) => ({
    x: a * COL_STEP - 30,
    y: -40,
    w: (b - a) * COL_STEP + CARD_W + 60,
    h: Math.max(...[...cards.values()].filter((c) => c.col >= a && c.col <= b).map((c) => c.y + c.h)) + 80,
  });
  const top = candidates;
  const TREE_TOP = (() => {
    const xs = top.flatMap((n) => [n.tx - 260, n.tx + 260]);
    const x = Math.min(...xs);
    return { x, y: TREE_Y0 - 120, w: Math.max(...xs) - x, h: 4 * DY + 120 };
  })();
  const CAMERA = [
    [0, REPO],
    [1.4, REPO],
    [3, colsView(0, 1)],
    [4.6, colsView(0, 1)],
    [6, colsView(2, 3)],
    [7.2, colsView(2, 3)],
    [8.6, REPO],
    [10.2, ZOOM_FN],
    [11.4, ZOOM_FN],
    [13.6, union(featCard, TREE)],
    [15.2, TREE],
    [16.8, TREE],
    [17.8, TREE_TOP],
    [21.4, TREE_TOP],
    [23.4, union(TOKENS, { x: TREE.x, y: TREE.y + TREE.h * 0.4, w: TREE.w, h: 10 })],
    [25, TOKENS],
    [35.4, TOKENS],
    [37.6, REPO],
    [43.6, REPO],
    [47.4, INDEX],
    [59.4, INDEX],
    [61, GROUPS],
    [67.6, GROUPS],
    [69.6, SKETCH],
    [75.4, SKETCH],
    [76.4, GROUPS],
    [77.8, GROUPS],
    [79.4, union(GROUPS, RANK)],
    [80.6, RANK],
    [91.6, RANK],
    [93.4, GRAPH],
    [105.4, GRAPH],
    [107, reportView(0)],
    [118.6, reportView(1)],
    [120, reportView(1)],
  ];
  const scene = document.getElementById("scene");
  let sceneW = 1;
  let sceneH = 1;
  function camera(t) {
    const r = track(t, CAMERA.map(([tt, v]) => [tt, { x: v.x, y: v.y, w: v.w, h: v.h }]));
    // Cover the target rect at the scene's aspect ratio, centered on it.
    const a = sceneW / sceneH;
    let w = r.w;
    let h = r.h;
    if (w / h > a) h = w / a;
    else w = h * a;
    // Keep a margin, so labels at the edge stay clear of the frame.
    w *= 1.04;
    h *= 1.04;
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    attr(world, "viewBox", `${fmt(cx - w / 2)} ${fmt(cy - h / 2)} ${fmt(w)} ${fmt(h)}`);
    return { x: cx - w / 2, y: cy - h / 2, w, h };
  }

  // --------------------------------------------------------------- follow --
  let followed = null;
  const followSel = document.getElementById("follow");
  const FOLLOW_CHOICES = [
    ["src/orders/total.ts", "FunctionDeclaration", "orderTotal (the original)"],
    ["src/invoice/total.ts", "FunctionDeclaration", "orderTotal (pasted into invoice)"],
    ["src/cart/subtotal.ts", "FunctionDeclaration", "cartSubtotal (renamed)"],
    ["src/reports/rows.ts", "FunctionDeclaration", "reportTotal (one line added)"],
    ["src/orders/total.ts", "Block", "orderTotal's body"],
    ["src/orders/types.ts", "InterfaceDeclaration", "LineItem interface"],
    ["src/orders/total.test.ts", "ArrayLiteralExpression", "test fixture array"],
    ["src/reports/rows.ts", "ForOfStatement", "reportTotal's loop (no match)"],
  ];
  {
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "Nothing";
    followSel.appendChild(none);
    for (const [file, kind, name] of FOLLOW_CHOICES) {
      const f = frags.find((x) => x.file === file && x.kind === kind);
      if (!f) continue;
      const o = document.createElement("option");
      o.value = f.key;
      o.textContent = name;
      followSel.appendChild(o);
    }
    followSel.addEventListener("change", () => follow(followSel.value || null, true));
  }
  function follow(key, user) {
    followed = key ? fragByKey.get(key) : null;
    if (user && followSel.value !== (key || "")) {
      const has = [...followSel.options].some((o) => o.value === key);
      if (!has && key) {
        const o = document.createElement("option");
        o.value = key;
        o.textContent = `${short(followed.kind)} · ${base(followed.file)}:${followed.line}`;
        followSel.appendChild(o);
      }
      followSel.value = key || "";
    }
    try {
      if (key) localStorage.setItem("tour-follow", key);
      else localStorage.removeItem("tour-follow");
    } catch {
      /* storage is a convenience */
    }
    requestRender(true);
  }

  // ------------------------------------------------------------- captions --
  const fnName = (p) => (p === featuredPath ? "orderTotal" : "cartSubtotal");
  void fnName;
  const testArray = frags.find((f) => f.kind === "ArrayLiteralExpression" && f.file.endsWith(".test.ts"));
  const CAPTIONS = [
    [0, "This is a small shop codebase: 8 files and 100 lines. A few functions add up totals, and they look a lot alike. Scroll, or press Play, to watch thicket read it."],
    [4, "Every fingerprint, group and score on this page comes from one real run of thicket over these files. The finished report is at the bottom of the page."],
    [8, "thicket starts by parsing each file. Here is <code>orderTotal</code> in <code>src/orders/total.ts</code>."],
    [11, "The parser turns the text into a syntax tree. Each part of the code becomes a node. Watch each piece drop into its place."],
    [15, `thicket counts the nodes under each node. The whole function holds ${D.tree.nodes}.`],
    [17.4, `A subtree is worth comparing when it has at least ${D.minNodes} nodes and spans at least ${D.minLines} lines. Three subtrees have enough nodes. The <code>for…of</code> loop spans only 3 lines, so it drops out.`],
    [20, "That leaves 2 fragments in this function: the function itself and its body. A bracket in the margin marks each one."],
    [22, "To compare fragments quickly, thicket flattens each one into a row of tokens. A token is a node's kind, or the text of a name or a value. The parentheses keep the tree's shape. Long kind names are shortened here."],
    [25, `thicket hashes the row into a short fingerprint, <code>${hashOf(featuredPath, "l0")}</code>. Two fragments with the same fingerprint have the same code. This is the L0 fingerprint.`],
    [27.4, `Here is <code>cartSubtotal</code> from <code>src/cart/subtotal.ts</code>. The structure matches, but the names differ. So its L0 fingerprint differs too.`],
    [30, "For the L1 fingerprint, thicket renumbers every name in the order it first appears. <code>orderTotal</code> and <code>cartSubtotal</code> both become #0. Values like <code>0</code> keep their kind and lose their text."],
    [32.8, `Now the two rows are identical, so both L1 fingerprints are <code>${hashOf(featuredPath, "l1")}</code>. These two functions are one shape with renamed parts.`],
    [36, "thicket does the same for every file. Each bracket in a margin is one fragment."],
    [40, `The sample has ${frags.length} fragments, and each one has both fingerprints. Most of them are nested inside each other.`],
    [44, "thicket files each fragment under its L0 fingerprint. Fragments that land in the same slot are exact copies."],
    [50.6, "Three slots hold more than one fragment: the pasted <code>orderTotal</code>, its body, and a test fixture array. Each becomes a group."],
    [53, `Then thicket files them again under L1. A fragment that is mostly values sits this pass out, because ignoring its values would match unrelated data. The test array is ${Math.round(testArray.literalShare * 100)}% values, over the 35% limit.`],
    [57.2, "Three more groups form: the renamed function, its body, and two interfaces that differ only in their names. That makes 6 groups."],
    [60, "Some groups are copies inside copies. Each copy of the body sits inside a copy of the function."],
    [63, "A group whose copies all sit inside a bigger group adds nothing to the report. thicket drops it, and 4 groups remain."],
    [68, `<code>reportTotal</code> in <code>${nearFrag.file}</code> matched nothing. It has one extra line, so both of its fingerprints differ.`],
    [70, `thicket also keeps a sketch of each fragment: ${D.sketchBins} small hashes of its runs of 5 tokens, with names ignored. Similar code gets similar sketches.`],
    [72.6, `It compares two sketches bin by bin. ${D.near.match} of the ${D.near.of} filled bins agree. That is ${Math.round((D.near.match / D.near.of) * 100)}%, which meets the 80% bar for a near copy.`],
    [76, "So <code>reportTotal</code> joins the renamed group as a near copy. The report lists it apart, because it needs a small change before it fits."],
    [78, "Now thicket scores each group. The score grows with the size of one copy, raised to the power 1.5. So one long copy beats several short ones."],
    [80.4, "It grows more slowly with the number of copies. Copies in different modules count more, because merging them also removes a dependency."],
    [82.4, "The renamed group pays two discounts. Renamed copies count a little less than exact ones. And its field names differ: <code>items</code> in one copy, <code>lines</code> in another. When copies use different field names, they may hold different ideas. So the score keeps only 25%."],
    [86.2, "Types and tests are scored too, but each goes into a section of its own. A test fixture never takes a slot from production code."],
    [92, "Duplication is half of the report. The other half is imports. thicket draws an arrow from each file to every file it imports. A dashed arrow imports only types, which disappear at compile time."],
    [97.8, "Three files import each other in a ring: <code>orders/total.ts</code> needs <code>invoice/total.ts</code>, which needs <code>reports/rows.ts</code>, which needs <code>orders/total.ts</code>. A ring like this can fail at startup, when one file runs before another has finished loading."],
    [101, `thicket looks for the cheapest import to remove. Each import here carries one symbol. Moving <code>formatMoney</code> out of <code>reports/rows.ts</code> breaks the ring completely.`],
    [106, "Last, thicket writes the report. Each finding names its copies and shows the first lines of the code."],
    [111.5, "The import ring gets a chart and a suggested cut. An agent reads this report and decides what to change. thicket only points."],
    [116.5, "The same code always gives the same report, byte for byte. So you can run thicket after each change and compare the two reports."],
  ];

  // HUD: one live number per chapter.
  const hudN = document.getElementById("hud-n");
  const hudL = document.getElementById("hud-l");
  function hud(t) {
    const count = (target, a, b) => Math.round(target * lin(t, a, b));
    if (t < 8) return [String(D.files.length), `files · ${json.lineCount} lines`];
    if (t < 22) return [String(count(D.tree.nodes, 14.6, 16.6) || 0), "nodes in orderTotal"];
    if (t < 36) return [t < 32.6 ? (t < 27.4 ? "1" : "2") : "1", t < 32.6 ? (t < 27.4 ? "L0 fingerprint" : "L0 fingerprints") : "L1 fingerprint, shared"];
    if (t < 44) return [String(count(frags.length, 36.4, 42)), "fragments"];
    if (t < 60) return [String(t < 51 ? 0 : t < 57.4 ? 3 : 6), "groups"];
    if (t < 68) return [t < 64 ? "6" : "4", "groups"];
    if (t < 78) {
      const done = bins.filter((b) => b.t <= t && b.state !== "skip");
      const agree = done.filter((b) => b.state === "agree").length;
      return [done.length ? Math.round((agree / done.length) * 100) + "%" : "–", "of bins agree"];
    }
    if (t < 92) return [String(kept.length), "findings ranked"];
    if (t < 106) return [t < 98 ? "0" : "1", t < 98 ? "cycles" : "cycle, 3 files"];
    return [String(json.duplication.length + json.typeDuplication.length + json.cycles.length), "findings in the report"];
  }

  // ------------------------------------------------------------- inspector --
  const inspector = document.getElementById("inspector");
  function inspect(t) {
    if (!followed) {
      inspector.hidden = true;
      return;
    }
    inspector.hidden = false;
    const f = followed;
    const rows = [];
    rows.push(["Source", `<code>${f.file}</code> lines ${f.line}–${f.endLine}`]);
    rows.push(["Node", `${kindName(f.kind)}, ${f.nodes} nodes`]);
    const featured = f.file === featuredPath && f.kind === "FunctionDeclaration";
    if (t >= (featured ? 25 : 40)) rows.push(["L0", `<code>${f.l0}</code>`]);
    if (t >= (featured ? 32.6 : 40)) {
      rows.push(["L1", f.eligible ? `<code>${f.l1}</code>` : `skipped, ${Math.round(f.literalShare * 100)}% values`]);
    }
    if (t >= 51) {
      const g0 = f.group0;
      const g1 = t >= 57.4 ? f.group1 : null;
      const parts = [];
      if (g0) parts.push(`exact copy, ${g0.members.length} in group`);
      if (g1) parts.push(`renamed copy, ${g1.members.length} in group`);
      if (!parts.length) parts.push(f === nearFrag && t >= 76 ? "near copy, 80% alike" : "unique so far");
      rows.push(["Index", parts.join("; ")]);
    }
    if (t >= 63) {
      const gs = [f.group0, f.group1].filter(Boolean);
      const dropped = gs.filter((g) => !g.kept);
      if (dropped.length && dropped.length === gs.length) rows.push(["Nested", "dropped: inside the function's group"]);
    }
    const mine = kept.filter((c) => c.members.includes(f) || (c === nearGroup && f === nearFrag && t >= 76));
    if (t >= 90 && mine.length) {
      rows.push([
        "Finding",
        mine
          .map((c) => `<code>${c.finding.id}</code>, #${c.place} in ${SECTIONS.find((s) => s.id === c.finding.section).title.toLowerCase()}, score ${fmt(c.score)}`)
          .join("<br>"),
      ]);
    }
    if (t >= 97.8 && inCycle.has(f.file)) rows.push(["Imports", "its file is in the import ring"]);
    if (t >= 108) {
      const lines = reportLines.filter((r) => r.cls === "r-bullet" && r.text.includes(f.file + ":")).length;
      rows.push(["Report", lines ? `named in ${lines} finding${lines === 1 ? "" : "s"}` : "not in the report"]);
    }
    const html =
      `<p class="insp-title">Following <strong>${short(f.kind)}</strong> · ${base(f.file)}:${f.line}</p><dl>` +
      rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("") +
      `</dl><button type="button" class="insp-clear" id="insp-clear">Stop following</button>`;
    if (inspector._h !== html) {
      inspector.innerHTML = html;
      inspector._h = html;
      document.getElementById("insp-clear").addEventListener("click", () => follow(null, true));
    }
  }

  // --------------------------------------------------------------- render --
  function renderCards(t) {
    // The featured lines light up while the tree grows out of them.
    const band = cardEls.get(featuredPath).band;
    const fn = treeNodes[0];
    const bo = prog(t, 10, 11) * (1 - prog(t, 21, 22.5));
    attr(band, "y", fmt(lineTop(featCard, fn.line)));
    attr(band, "height", fmt((fn.endLine - fn.line + 1) * LH));
    show(band, bo);
    for (const f of frags) {
      const appear = f.file === featuredPath ? 20.6 + f.depth * 0.3 : 36.6 + fileOrder.indexOf(f.file) * 0.55 + f.depth * 0.12;
      const o = prog(t, appear, appear + 0.6);
      show(f.bracket, o);
      const fate = t < 51 ? "" : f.group0 || (t >= 57.4 && f.group1) ? ((f.group0 && f.group0.kept) || (f.group1 && f.group1.kept) ? "kept" : t < 63 ? "kept" : "dropped") : f === nearFrag && t >= 76 ? "near" : "single";
      cls(f.bracket, "fate-kept", fate === "kept");
      cls(f.bracket, "fate-dropped", fate === "dropped");
      cls(f.bracket, "fate-near", fate === "near");
      cls(f.bracket, "fate-single", fate === "single");
      cls(f.bracket, "followed", followed === f);
    }
  }

  function nodePos(n, t) {
    // Text → tree → token row.
    const k1 = prog(t, n.arrive - 1.5, n.arrive);
    const tokStart = 22.3 + n.pre * 0.035;
    const k2 = prog(t, tokStart, tokStart + 1.5);
    const x = mix(mix(n.ox, n.tx, k1), n.tok.x + n.tok.w / 2, k2);
    const y = mix(mix(n.oy, n.ty, k1), n.tok.ya, k2);
    const s = mix(0.55, 1, k1);
    return { x, y, s, k1, k2 };
  }

  function renderTree(t) {
    const visible = t > 10.6 && t < 36.5;
    show(L.tree, visible ? 1 : 0);
    show(L.tokens, t > 21.8 && t < 36.5 ? 1 : 0);
    if (!visible) return;
    const flip = (tok) => 30 + tok.i * 0.022;
    for (const n of treeNodes) {
      const p = nodePos(n, t);
      const o = prog(t, n.arrive - 1.6, n.arrive - 1.3) * (1 - prog(t, 35.6, 36.4));
      const tok = n.tok;
      // At the flip, the token squashes and comes back as its L1 text.
      const fk = lin(t, flip(tok) - 0.18, flip(tok) + 0.18);
      const sy = n.role === "id" || n.role === "lit" ? Math.max(0.06, Math.abs(1 - 2 * fk)) : 1;
      put(n.g, p.x, p.y, p.s, o, p.s * sy);
      const w = mix(n.w, tok.w, p.k2);
      attr(n.rect, "x", fmt(-w / 2));
      attr(n.rect, "width", fmt(w));
      const text = p.k2 < 0.5 ? n.label : fk < 0.5 ? tok.texts[0] : tok.texts[2];
      txt(n.text, text);
      if (n.badge) show(n.badge, prog(t, 14.6 + (treeDepth - n.depth) * 0.16, 15 + (treeDepth - n.depth) * 0.16) * (1 - prog(t, 22, 22.6)));
      const cand = n.nodes >= D.minNodes;
      cls(n.g, "cand", cand && t >= 17.6 && t < 22.4);
      const ok = cand && n.lines >= D.minLines;
      cls(n.g, "frag", ok && t >= 19.6 && t < 22.4);
      cls(n.g, "reject", cand && !ok && t >= 18.8 && t < 22.4);
      cls(n.g, "diff", tok.diff && t >= 28.2 && t < flip(tok));
      cls(n.g, "l1", t >= flip(tok) && (n.role === "id" || n.role === "lit"));
      cls(n.g, "followed", !!followed && followed.file === featuredPath && ((followed.kind === "FunctionDeclaration" && n === treeNodes[0]) || (followed.kind === "Block" && n.kind === "Block" && n.depth === 1)));
    }
    for (const { n, line } of treeEdges) {
      const a = nodePos(n.parent, t);
      const b = nodePos(n, t);
      attr(line, "x1", fmt(a.x));
      attr(line, "y1", fmt(a.y));
      attr(line, "x2", fmt(b.x));
      attr(line, "y2", fmt(b.y));
      show(line, prog(t, n.arrive - 0.2, n.arrive + 0.3) * (1 - prog(t, 22, 22.8)));
    }
    for (const v of verdicts) {
      const at = v.ok ? 18.8 : 18.4;
      const p = nodePos(v.n, t);
      put(v.g, p.x, p.y - 36, 1, prog(t, at, at + 0.5) * (1 - prog(t, 22, 22.5)));
    }
    // Token rows
    for (const e of tokEls) {
      const tk = e.t;
      const fk = lin(t, flip(tk) - 0.18, flip(tk) + 0.18);
      const sy = tk.role === "id" || tk.role === "lit" ? Math.max(0.06, Math.abs(1 - 2 * fk)) : 1;
      if (e.a) {
        txt(e.a.s, tk.texts[0]);
        put(e.a.g, tk.x, tk.ya, 1, prog(t, 24.2 + tk.i * 0.006, 25) * (1 - prog(t, 35.6, 36.4)));
      }
      const bo = prog(t, 27.4 + tk.i * 0.01, 28.2 + tk.i * 0.01) * (1 - prog(t, 35.6, 36.4));
      const dy = (1 - prog(t, 27.4 + tk.i * 0.01, 28.2 + tk.i * 0.01)) * 22;
      put(e.b.g, tk.x, tk.yb + dy, 1, bo, sy);
      txt(e.b.s, fk < 0.5 ? tk.texts[1] : tk.texts[3]);
      cls(e.b.g, "diff", tk.diff && t >= 28.2 && t < flip(tk));
      cls(e.b.g, "l1", t >= flip(tk) && (tk.role === "id" || tk.role === "lit"));
    }
    show(rowLabels[0], prog(t, 23, 24) * (1 - prog(t, 35.6, 36.4)));
    show(rowLabels[1], prog(t, 27.4, 28.2) * (1 - prog(t, 35.6, 36.4)));
    const seed = Math.floor(t * 18);
    show(hpa.g, prog(t, 25, 25.6) * (1 - prog(t, 35.6, 36.4)));
    txt(hpa.l0, scramble(hashOf(featuredPath, "l0"), lin(t, 25.2, 26.4), seed));
    txt(hpa.l1, t < 32.4 ? "" : scramble(hashOf(featuredPath, "l1"), lin(t, 32.4, 33.4), seed + 3));
    show(hpb.g, prog(t, 27.6, 28.2) * (1 - prog(t, 35.6, 36.4)));
    txt(hpb.l0, scramble(hashOf("src/cart/subtotal.ts", "l0"), lin(t, 27.8, 29), seed + 5));
    txt(hpb.l1, t < 32.6 ? "" : scramble(hashOf("src/cart/subtotal.ts", "l1"), lin(t, 32.6, 33.6), seed + 7));
    show(sameMark, prog(t, 33.6, 34.2) * (1 - prog(t, 35.6, 36.4)));
  }

  function renderIndex(t) {
    show(L.cells, prog(t, 44.4, 45.4));
    const k = prog(t, 53.2, 54.6);
    for (const c of cells) {
      show(c.l0, c.has0 ? 1 - k : 0);
      show(c.l1, c.has1 ? k : 0);
      show(c.b0, c.n0 > 1 && t >= 50.6 ? 1 - k : 0);
      show(c.b1, c.n1 > 1 && t >= 57.2 ? k : 0);
      const filled = (c.has0 && k < 0.5) || (c.has1 && k >= 0.5);
      cls(c.g, "empty", !filled);
      cls(c.g, "hit0", k < 0.5 && c.hit0 !== null && t >= c.hit0);
      cls(c.g, "hit1", c.hit1 !== null && t >= c.hit1);
      cls(c.g, "hit1-exact", c.hit1 !== null && t >= c.hit1 && c.g0);
      let pk = 0;
      let renamed = false;
      for (const at of [c.hit0, c.hit1]) {
        if (at === null) continue;
        const q = lin(t, at, at + 0.9);
        if (q > 0 && q < 1) {
          pk = q;
          renamed = at === c.hit1 && !c.g0;
        }
      }
      cls(c.ring, "l1", renamed);
      put(c.ring, c.cx, c.cy, 1 + ease(pk) * 0.3, pk > 0 ? (1 - pk) * 0.9 : 0);
    }
  }

  function renderChips(t) {
    for (const f of frags) {
      const fly = prog(t, f.t0, f.t0 + 1.5);
      const appear = prog(t, f.t0, f.t0 + 0.25);
      const move = prog(t, f.t1, f.t1 + 1.2);
      // Flights arc, so a chip reads as thrown rather than slid.
      let x = mix(mix(f.bx - CHIP_W * 0.18, f.cell0.x, fly), f.cell1.x, move);
      let y =
        mix(mix(f.by - CHIP_H * 0.2, f.cell0.y, fly), f.cell1.y, move) -
        Math.sin(Math.PI * fly) * 220 -
        Math.sin(Math.PI * move) * (f.cell0.x === f.cell1.x && f.cell0.y === f.cell1.y ? 0 : 70);
      let s = mix(0.35, 1, fly);
      // The near copy leaves the index for its group.
      if (f === nearFrag) {
        const go = prog(t, 76, 77.6);
        const tgt = nearGroup;
        const gp = groupPos(tgt, t);
        x = mix(x, gp.x + 24, go);
        y = mix(y, gp.y + 58 + tgt.members.length * MEMBER_H, go);
        s = mix(s, 0.9, go);
      }
      const leave = 1 - prog(t, 79, 80.5);
      put(f.chip, x, y, s, appear * leave);
      txt(f.chipHash, t < 53.4 || !f.eligible ? f.l0 : f.l1);
      txt(f.chipTag, t >= 53.4 && !f.eligible ? `${Math.round(f.literalShare * 100)}% values` : short(f.kind));
      cls(f.chip, "ineligible", t >= 53.4 && !f.eligible);
      const inG0 = !!f.group0 && t >= 50.6;
      const inG1 = !!f.group1 && t >= 57.2;
      cls(f.chip, "g0", inG0);
      cls(f.chip, "g1", inG1);
      cls(f.chip, "near-hit", f === nearFrag && t >= 68 && t < 78);
      cls(f.chip, "dim", t >= 59 && !inG0 && !inG1 && f !== nearFrag);
      cls(f.chip, "followed", followed === f);
    }
  }

  function groupPos(c, t) {
    const spawn = prog(t, c.spawn, c.spawn + 1.4);
    const nest = prog(t, 63, 65.4);
    const rank = prog(t, 78.6, 80.2);
    const sect = prog(t, 89.8, 91.4);
    let x = mix(c.cx, GROUPS_X, spawn);
    let y = mix(c.cy, c.gy0, spawn) - Math.sin(Math.PI * spawn) * 160;
    y = mix(y, c.gy1, nest);
    if (c.kept) {
      x = mix(x, RANK_X, rank);
      y = mix(y, c.ry0, rank);
      y = mix(y, c.ry1, sect);
    }
    return { x, y, s: mix(0.35, 1, spawn) };
  }

  function renderGroups(t) {
    for (const c of order) {
      const p = groupPos(c, t);
      let o = prog(t, c.spawn, c.spawn + 0.4);
      if (!c.kept) o *= 1 - prog(t, 64.4, 65.6);
      put(c.g, p.x, p.y, p.s, o);
      const nearK = c === nearGroup ? prog(t, 77, 77.8) : 0;
      const rank = c.kept ? prog(t, 78.6, 80.2) : 0;
      const h = mix(groupH(c, false) + nearK * MEMBER_H, 140, rank);
      const w = mix(GROUP_W, RANK_W, rank);
      attr(c.bg, "height", fmt(h));
      attr(c.bg, "width", fmt(w));
      attr(c.stripe, "height", fmt(h));
      show(c.membersG, 1 - rank);
      if (c.nearRow) show(c.nearRow, nearK);
      if (c.inside) show(c.inside, prog(t, 61, 61.8));
      cls(c.g, "nesting", !c.kept && t >= 61 && t < 65);
      cls(c.g, "parent", c.kept && raw.some((d) => d.parent === c) && t >= 61 && t < 65);
      const mine = !!followed && (c.members.includes(followed) || (c === nearGroup && followed === nearFrag && t >= 77));
      cls(c.g, "followed", mine);
      for (const r of c.memberRows) cls(r.row, "followed", r.m === followed);
      if (c.nearRow) cls(c.nearRow, "followed", followed === nearFrag);
      if (c.kept) {
        show(c.rankG, rank);
        // Each factor lands, and the bar grows to the running product.
        let product = 1;
        let shown = 0;
        c.factors.forEach((f, i) => {
          const at = c.rankStart + i * c.rankStep;
          const k = prog(t, at, at + 0.45);
          const e = c.factorEls[i];
          put(e.fg, e.x, 58 + (1 - k) * 10, 1, k);
          product *= mix(1, f.value, k);
          if (k > 0) shown = i + 1;
        });
        void shown;
        const width = Math.max(0, (t < c.rankStart ? 0 : product) * barScale);
        attr(c.bar, "width", fmt(Math.min(width, BAR_MAX + 200)));
        const done = t >= c.rankStart + (c.factors.length - 1) * c.rankStep + 0.45;
        txt(c.scoreT, t < c.rankStart ? "" : done ? fmt(c.score) : fmt(product));
        attr(c.scoreT, "x", fmt(24 + Math.min(width, BAR_MAX + 200) + 12));
        cls(c.g, "scored", done);
        txt(c.placeT, t >= 91 ? "#" + c.place : "");
        show(c.placeT, prog(t, 90.8, 91.4));
        show(c.title, 1);
      }
    }
    for (const e of sectionEls) {
      put(e.t, RANK_X, e.s.y + 30, 1, prog(t, 90, 91.2));
    }
  }

  function renderSketch(t) {
    const o = prog(t, 69.6, 70.4) * (1 - prog(t, 78.4, 79.4));
    show(L.sketch, o);
    if (o === 0) return;
    let done = 0;
    let agree = 0;
    for (const b of bins) {
      const on = t >= b.t;
      for (const side of ["a", "b"]) {
        const r = skEls[side][b.i];
        cls(r, "agree", on && b.state === "agree");
        cls(r, "differ", on && b.state === "differ");
        cls(r, "skip", on && b.state === "skip");
      }
      if (on && b.state !== "skip") {
        done++;
        if (b.state === "agree") agree++;
      }
    }
    const sweep = lin(t, bins[0].t, bins[bins.length - 1].t);
    const col = Math.floor(sweep * (D.sketchBins - 1)) % SK_COLS;
    attr(scan, "x", fmt(SK_X + col * SK_CELL + SK_CELL / 2 - 2));
    show(scan, sweep > 0 && sweep < 1 ? 0.8 : 0);
    txt(skMeter, done ? `${agree} of ${done} filled bins agree` : "");
    const pct = Math.round((D.near.match / D.near.of) * 100);
    txt(skVerdict, t >= 74.4 ? `${pct}% alike · near copy at 80% or more ✓` : "");
  }

  function renderGraph(t) {
    const on = prog(t, 92, 93) * (1 - prog(t, 106.4, 107.4));
    show(L.graph, on);
    if (on === 0) return;
    for (const { n, g } of gNodeEls) {
      const ringK = prog(t, 97.8, 98.6);
      const dim = inCycle.has(n.path) ? 1 : mix(1, 0.4, ringK * (1 - prog(t, 104, 105)));
      show(g, prog(t, 92.4, 93.2) * dim);
      cls(g, "followed", !!followed && followed.file === n.path);
    }
    for (const el of gEdgeEls) {
      const k = prog(t, el.e.t, el.e.t + 0.9);
      // A dashed edge cannot also draw itself with a dash, so it fades in.
      if (!el.e.typeOnly) attr(el.path, "stroke-dashoffset", fmt(1 - k, 3));
      else show(el.path, k);
      show(el.lg, prog(t, el.e.t + 0.6, el.e.t + 1.1));
      const ringK = prog(t, 97.8, 98.6);
      const fade = el.e.ring ? 1 : mix(1, 0.35, ringK * (1 - prog(t, 104, 105)));
      const cutK = el.e.cut ? prog(t, 102.8, 103.8) : 0;
      show(el.g, Math.max(0.12, fade * (1 - cutK * 0.8)));
      cls(el.g, "lit", el.e.ring && t >= 97.8 && t < 103.8);
      cls(el.g, "cutting", el.e.cut && t >= 101.4);
    }
    show(hull, prog(t, 97.8, 98.6) * (1 - prog(t, 102.8, 103.8)));
    // A dot walks the ring once, the way the cycle search follows it.
    const walk = lin(t, 98.4, 100.8);
    if (walk > 0 && walk < 1 && ringWalk.length) {
      const seg = Math.min(ringWalk.length - 1, Math.floor(walk * ringWalk.length));
      const local = walk * ringWalk.length - seg;
      const path = ringWalk[seg].path;
      const total = path.getTotalLength();
      const pt = path.getPointAtLength(ease(local) * total);
      attr(pulse, "cx", fmt(pt.x));
      attr(pulse, "cy", fmt(pt.y));
      show(pulse, 1);
    } else show(pulse, 0);
    show(cutNote, prog(t, 101.6, 102.4));
  }

  function renderReport(t) {
    show(L.report, prog(t, 105.6, 106.6));
    let last = -1;
    reportEls.forEach((e, i) => {
      const r = reportLines[i];
      const k = prog(t, r.t, r.t + 0.25);
      show(e, k);
      if (t >= r.t) last = i;
      const hit = !!followed && r.cls === "r-bullet" && r.text.includes(followed.file + ":");
      const hitHead = !!followed && r.cls === "r-h3" && kept.some((c) => c.members.includes(followed) && r.text.includes(c.finding.id));
      cls(e, "followed", hit || hitHead);
    });
    if (last >= 0 && t < reportStart + reportSpan + 0.5) {
      const r = reportLines[last];
      attr(caret, "x", fmt(PAPER.x + 60 + Math.min(r.text.length, 104) * RFS * 0.6 + 4));
      attr(caret, "y", fmt(r.y - 14));
      show(caret, Math.floor(t * 6) % 2 ? 0.9 : 0.25);
    } else show(caret, 0);
  }
  void findLine;

  // ----------------------------------------------------------------- rail --
  const chaptersEl = document.getElementById("chapters");
  const captionEl = document.getElementById("caption");
  const chapterEls = CHAPTERS.map((c, i) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.innerHTML = `<span class="ch-n">${i + 1}</span><span class="ch-t">${c.title}</span><span class="ch-fill"></span>`;
    b.addEventListener("click", () => jump(c.t0 + 0.01));
    li.appendChild(b);
    chaptersEl.appendChild(li);
    return { li, b, fill: b.querySelector(".ch-fill") };
  });
  const scrub = document.getElementById("scrub");
  const scrubFill = document.getElementById("scrub-fill");
  const scrubTicks = document.getElementById("scrub-ticks");
  for (const c of CHAPTERS) {
    const s = document.createElement("span");
    s.style.left = (c.t0 / T_END) * 100 + "%";
    s.title = c.title;
    scrubTicks.appendChild(s);
  }
  const nowEl = document.getElementById("now");
  const map = document.getElementById("map");
  const mapView = document.getElementById("map-view");
  const WORLD_X0 = REPO.x;
  const WORLD_X1 = PAPER.x + PAPER.w + 100;
  const MAP_REGIONS = [
    ["Code", REPO],
    ["Index", INDEX],
    ["Groups", GROUPS],
    ["Sketch", SKETCH],
    ["Rank", RANK],
    ["Imports", GRAPH],
    ["Report", PAPER],
  ];
  for (const [name, r] of MAP_REGIONS) {
    const s = document.createElement("span");
    s.className = "map-region";
    s.style.left = ((r.x - WORLD_X0) / (WORLD_X1 - WORLD_X0)) * 100 + "%";
    s.style.width = (r.w / (WORLD_X1 - WORLD_X0)) * 100 + "%";
    s.textContent = name;
    map.insertBefore(s, mapView);
  }

  function renderRail(t, view) {
    const ci = Math.max(0, CHAPTERS.findIndex((c) => t < c.t1) === -1 ? CHAPTERS.length - 1 : CHAPTERS.findIndex((c) => t < c.t1));
    chapterEls.forEach((e, i) => {
      const c = CHAPTERS[i];
      cls(e.li, "current", i === ci);
      cls(e.li, "done", t >= c.t1);
      e.fill.style.transform = `scaleX(${fmt(lin(t, c.t0, c.t1), 3)})`;
    });
    let cap = CAPTIONS[0][1];
    for (const [at, html] of CAPTIONS) if (t >= at) cap = html;
    const html = `<p class="cap-chapter">${ci + 1} of ${CHAPTERS.length} · ${CHAPTERS[ci].title}</p><p>${cap}</p>`;
    if (captionEl._h !== html) {
      captionEl.innerHTML = html;
      captionEl._h = html;
    }
    scrubFill.style.transform = `scaleX(${fmt(t / T_END, 4)})`;
    scrub.setAttribute("aria-valuenow", fmt(t, 1));
    scrub.setAttribute("aria-valuetext", CHAPTERS[ci].title);
    txt(nowEl, CHAPTERS[ci].title);
    const [n, l] = hud(t);
    txt(hudN, n);
    txt(hudL, l);
    const vx = (view.x - WORLD_X0) / (WORLD_X1 - WORLD_X0);
    const vw = view.w / (WORLD_X1 - WORLD_X0);
    mapView.style.left = clamp(vx, 0, 1) * 100 + "%";
    mapView.style.width = clamp(vw, 0.01, 1) * 100 + "%";
  }

  function render(t) {
    const view = camera(t);
    renderCards(t);
    renderTree(t);
    renderIndex(t);
    renderGroups(t);
    renderChips(t);
    renderSketch(t);
    renderGraph(t);
    renderReport(t);
    renderRail(t, view);
    inspect(t);
  }

  // ------------------------------------------------------------- controls --
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  const BEAT_PX = 72;
  const stage = document.getElementById("stage");
  const playBtn = document.getElementById("play");
  const speedBtn = document.getElementById("speed");
  let target = 0;
  let shown = -1;
  let playing = false;
  let rate = 1.5;
  let lastFrame = 0;
  let raf = 0;
  let programmatic = 0;

  function header() {
    const h = document.querySelector("header.site");
    if (!h || getComputedStyle(h).position !== "sticky") return 0;
    return h.getBoundingClientRect().height;
  }
  function layoutPage() {
    const hdr = header();
    document.documentElement.style.setProperty("--hdr", hdr + "px");
    const rect = scene.getBoundingClientRect();
    sceneW = Math.max(1, rect.width);
    sceneH = Math.max(1, rect.height);
    root.style.height = T_END * BEAT_PX + stage.getBoundingClientRect().height + "px";
  }
  const rootTop = () => root.getBoundingClientRect().top + window.scrollY - header();
  const tFromScroll = () => clamp((window.scrollY - rootTop()) / BEAT_PX, 0, T_END);
  function scrollToT(t) {
    programmatic = 2;
    window.scrollTo(0, rootTop() + t * BEAT_PX);
  }

  function frame(now) {
    raf = 0;
    const dt = lastFrame ? Math.min(0.1, (now - lastFrame) / 1000) : 0;
    lastFrame = now;
    if (playing) {
      target = Math.min(T_END, target + dt * rate);
      scrollToT(target);
      if (target >= T_END) setPlaying(false);
    }
    // Ease the shown time toward the target, so a wheel step glides.
    if (shown < 0 || reduce.matches || Math.abs(target - shown) > 14) shown = target;
    else shown += (target - shown) * Math.min(1, dt * 9 || 0.25);
    if (Math.abs(target - shown) < 0.002) shown = target;
    render(shown);
    if (playing || shown !== target) raf = requestAnimationFrame(frame);
    else lastFrame = 0;
  }
  function requestRender(immediate) {
    if (immediate) render(shown < 0 ? target : shown);
    if (!raf) raf = requestAnimationFrame(frame);
  }
  function setPlaying(on) {
    playing = on;
    playBtn.setAttribute("aria-pressed", String(on));
    playBtn.querySelector(".label").textContent = on ? "Pause" : target >= T_END - 0.01 ? "Replay" : "Play";
    stage.classList.toggle("is-playing", on);
    if (on) {
      if (target >= T_END - 0.01) {
        target = 0;
        shown = 0;
        scrollToT(0);
      }
      const top = rootTop();
      if (window.scrollY < top - 2 || window.scrollY > top + T_END * BEAT_PX + 2) scrollToT(target);
      lastFrame = 0;
      requestRender();
    }
  }
  function jump(t) {
    setPlaying(false);
    target = clamp(t, 0, T_END);
    scrollToT(target);
    requestRender();
  }

  window.addEventListener(
    "scroll",
    () => {
      if (programmatic > 0) programmatic--;
      if (!playing) target = tFromScroll();
      requestRender();
    },
    { passive: true },
  );
  for (const ev of ["wheel", "touchstart"]) {
    window.addEventListener(ev, () => playing && setPlaying(false), { passive: true });
  }
  playBtn.addEventListener("click", () => setPlaying(!playing));
  speedBtn.addEventListener("click", () => {
    rate = rate === 1.5 ? 3 : rate === 3 ? 0.75 : 1.5;
    speedBtn.textContent = rate === 1.5 ? "1×" : rate === 3 ? "2×" : "½×";
    speedBtn.setAttribute("aria-label", `Playback speed ${speedBtn.textContent}`);
  });

  // Scrubber: drag anywhere on the track.
  const fromPointer = (e) => {
    const r = scrub.getBoundingClientRect();
    return clamp((e.clientX - r.left) / r.width) * T_END;
  };
  let dragging = false;
  scrub.addEventListener("pointerdown", (e) => {
    dragging = true;
    scrub.setPointerCapture(e.pointerId);
    jump(fromPointer(e));
  });
  scrub.addEventListener("pointermove", (e) => dragging && jump(fromPointer(e)));
  scrub.addEventListener("pointerup", () => (dragging = false));
  scrub.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 5 : 1;
    if (e.key === "ArrowRight") jump(target + step);
    else if (e.key === "ArrowLeft") jump(target - step);
    else if (e.key === "Home") jump(0);
    else if (e.key === "End") jump(T_END);
    else return;
    e.preventDefault();
  });

  // Keys work while the stage is on screen.
  document.addEventListener("keydown", (e) => {
    if (e.target.closest && e.target.closest("input, select, textarea, [role=slider]")) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const r = root.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) return;
    const ci = CHAPTERS.findIndex((c) => target < c.t1 - 0.05);
    if (e.key === " " || e.key === "k") {
      if (e.target.closest && e.target.closest("button")) return;
      setPlaying(!playing);
    } else if (e.key === "ArrowRight" || e.key === "l") {
      const next = CHAPTERS[Math.min(CHAPTERS.length - 1, (ci < 0 ? CHAPTERS.length - 1 : ci) + 1)];
      jump(next.t0 + 0.01);
    } else if (e.key === "ArrowLeft" || e.key === "j") {
      const cur = CHAPTERS[ci < 0 ? CHAPTERS.length - 1 : ci];
      const prev = target - cur.t0 > 1.5 ? cur : CHAPTERS[Math.max(0, (ci < 0 ? CHAPTERS.length - 1 : ci) - 1)];
      jump(prev.t0 + 0.01);
    } else return;
    e.preventDefault();
  });

  // A chapter can be linked: #rank, #imports.
  function fromHash() {
    const id = location.hash.slice(1);
    const c = CHAPTERS.find((x) => x.id === id);
    if (c) jump(c.t0 + 0.01);
  }
  window.addEventListener("hashchange", fromHash);

  const ro = new ResizeObserver(() => {
    layoutPage();
    requestRender(true);
  });
  ro.observe(scene);
  window.addEventListener("resize", () => {
    layoutPage();
    requestRender(true);
  });

  // Testing hook: render one moment without scrolling.
  window.__tour = { render: (t) => ((target = shown = t), render(t)), T_END, CHAPTERS };

  layoutPage();
  try {
    const saved = localStorage.getItem("tour-follow");
    if (saved && fragByKey.has(saved)) follow(saved, true);
  } catch {
    /* storage is a convenience */
  }
  const q = new URLSearchParams(location.search).get("t");
  if (q !== null) {
    target = shown = clamp(Number(q), 0, T_END);
  } else {
    target = tFromScroll();
  }
  fromHash();
  render(target);
  shown = target;
  document.getElementById("full-report").textContent = D.report.markdown;
})();
