/*
 * Demos for how-it-works.html. Plain browser JS, no dependencies, matching the
 * rest of the site build.
 *
 * These are teaching models, not the implementation. The fingerprint demo
 * tokenizes text where thicket walks a syntax tree, and it computes exact
 * Jaccard where thicket estimates it from a sketch. The constants (35%, 80%,
 * the score exponents and weights) are the real ones from src/.
 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) =>
  String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** Toggle aria-pressed on a group of buttons, and run `fn` with the key. */
function buttonGroup(root, attr, fn) {
  const buttons = $$(`[data-${attr}]`, root);
  const pick = (key) => {
    for (const b of buttons) b.setAttribute("aria-pressed", String(b.dataset[attr] === key));
    fn(key);
  };
  for (const b of buttons) b.addEventListener("click", () => pick(b.dataset[attr]));
  return pick;
}

/* ---- 1. fragments ------------------------------------------------------ */

function fragDemo() {
  const root = $("#frag-demo");
  if (!root) return;
  const label = $("#frag-label");
  const initial = label.textContent;
  let hot = null;
  const set = (el) => {
    if (hot) hot.classList.remove("hot");
    hot = el;
    if (!el) {
      label.textContent = initial;
      return;
    }
    el.classList.add("hot");
    const lines = el.textContent.split("\n").length;
    const depth = $$(".frag", root).filter((f) => f.contains(el) && f !== el).length;
    label.innerHTML =
      `<strong>${esc(el.dataset.kind)}</strong> · ${lines} line${lines === 1 ? "" : "s"}` +
      (depth ? ` · nested ${depth} deep` : " · the outermost fragment");
  };
  root.addEventListener("mouseover", (e) => set(e.target.closest(".frag")));
  root.addEventListener("mouseleave", () => set(null));
  // Touch screens have no hover, so a tap does the same thing.
  root.addEventListener("click", (e) => set(e.target.closest(".frag")));
}

/* ---- 2a. the AST and its flattened list -------------------------------- */

function astDemo() {
  const root = $("#ast-demo");
  if (!root) return;
  // item.price * item.qty, as the TypeScript AST has it.
  const tree = {
    kind: "BinaryExpression", x: 350, y: 25,
    kids: [
      { kind: "PropertyAccessExpression", x: 125, y: 95,
        kids: [{ leaf: "item", x: 70, y: 165 }, { leaf: "price", x: 180, y: 165 }] },
      { kind: "AsteriskToken", x: 350, y: 95, kids: [] },
      { kind: "PropertyAccessExpression", x: 575, y: 95,
        kids: [{ leaf: "item", x: 520, y: 165 }, { leaf: "qty", x: 630, y: 165 }] },
    ],
  };
  let id = 0;
  const all = [];
  const number = (n, parent) => {
    n.id = id++;
    n.parent = parent;
    all.push(n);
    for (const k of n.kids ?? []) number(k, n);
  };
  number(tree, null);

  // One token per node, wrapped in parentheses per child, as fragments.ts does.
  const flatten = (n, level, names, owners) => {
    const own = [...owners, n.id];
    let text;
    if (n.leaf === undefined) text = n.kind;
    else if (level === "l0") text = n.leaf;
    else {
      if (!names.has(n.leaf)) names.set(n.leaf, `v${names.size}`);
      text = names.get(n.leaf);
    }
    const out = [{ text, owners: own, t: n.leaf === undefined ? "kind" : "id" }];
    for (const k of n.kids ?? []) {
      out.push({ text: "(", owners: own, t: "p" });
      out.push(...flatten(k, level, names, own));
      out.push({ text: ")", owners: own, t: "p" });
    }
    return out;
  };

  const svg = $("svg", root);
  const label = (n) => n.leaf ?? n.kind;
  const width = (n) => Math.max(44, label(n).length * 7 + 18);
  svg.innerHTML =
    all
      .filter((n) => n.parent)
      .map((n) => `<line class="ast-edge" x1="${n.parent.x}" y1="${n.parent.y + 13}" x2="${n.x}" y2="${n.y - 13}"/>`)
      .join("") +
    all
      .map(
        (n) =>
          `<g class="ast-node${n.leaf ? " leaf" : ""}" data-n="${n.id}"><rect x="${n.x - width(n) / 2}" y="${n.y - 13}" width="${width(n)}" height="26" rx="6"/><text x="${n.x}" y="${n.y + 4}">${esc(label(n))}</text></g>`,
      )
      .join("");

  let level = "l0";
  let hot = null;
  const render = () => {
    const tokens = flatten(tree, level, new Map(), []);
    $(".ast-stream", root).innerHTML = tokens
      .map(
        (tok) =>
          `<span class="chip ${tok.t}${hot !== null && tok.owners.includes(hot) ? " hot" : ""}">${esc(tok.text)}</span>`,
      )
      .join("");
    for (const g of $$(".ast-node", svg)) g.classList.toggle("hot", Number(g.dataset.n) === hot);
  };
  const point = (e) => {
    const g = e.target.closest(".ast-node");
    hot = g ? Number(g.dataset.n) : null;
    render();
  };
  svg.addEventListener("mouseover", point);
  svg.addEventListener("click", point);
  svg.addEventListener("mouseleave", () => {
    hot = null;
    render();
  });
  buttonGroup(root, "ast", (key) => {
    level = key;
    render();
  })("l0");
}

/* ---- 2. fingerprints --------------------------------------------------- */

const KEYWORDS = new Set(
  (
    "async await break case catch class const continue default delete do else enum export extends " +
    "false finally for from function if import in instanceof interface let new null of return " +
    "static super switch this throw true try type typeof var void while yield readonly private " +
    "public protected implements abstract as number string boolean any unknown never"
  ).split(" "),
);

const TOKEN =
  /\/\/[^\n]*|\/\*[\s\S]*?\*\/|\s+|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\d[\d_]*(?:\.\d+)?)|([A-Za-z_$][\w$]*)|(=>|===|!==|==|!=|<=|>=|&&|\|\||\?\?|\?\.|\.\.\.|\+=|-=|\*=|\+\+|--|.)/gy;

/** Text to tokens. Comments and whitespace vanish, as they do in the tree. */
function tokenize(src) {
  const out = [];
  TOKEN.lastIndex = 0;
  let m;
  while (TOKEN.lastIndex < src.length && (m = TOKEN.exec(src))) {
    if (m[1] !== undefined) out.push({ t: "str", v: m[1] });
    else if (m[2] !== undefined) out.push({ t: "num", v: m[2] });
    else if (m[3] !== undefined) out.push({ t: KEYWORDS.has(m[3]) ? "kw" : "id", v: m[3] });
    else if (m[4] !== undefined) out.push({ t: "p", v: m[4] });
  }
  return out;
}

/** The three streams: L0 exact, L1 renamed, L2 the sketch's name-free view. */
function streams(tokens) {
  const seen = new Map();
  const l0 = [];
  const l1 = [];
  const l2 = [];
  let ids = 0;
  let lits = 0;
  for (const tok of tokens) {
    if (tok.t === "id") {
      ids++;
      if (!seen.has(tok.v)) seen.set(tok.v, `v${seen.size}`);
      l0.push(tok.v);
      l1.push(seen.get(tok.v));
      l2.push("id");
    } else if (tok.t === "str" || tok.t === "num") {
      lits++;
      l0.push(tok.v);
      l1.push(tok.t);
      l2.push(tok.t);
    } else {
      l0.push(tok.v);
      l1.push(tok.v);
      l2.push(tok.v);
    }
  }
  return { tokens, l0, l1, l2, literalShare: ids + lits === 0 ? 0 : lits / (ids + lits) };
}

/** Exact Jaccard over 5-token shingles. thicket estimates this with MinHash. */
function jaccard(a, b) {
  const shingles = (s) => {
    const set = new Set();
    for (let i = 0; i + 5 <= s.length; i++) set.add(s.slice(i, i + 5).join("\u0001"));
    return set;
  };
  const A = shingles(a);
  const B = shingles(b);
  if (A.size === 0 && B.size === 0) return 0;
  let both = 0;
  for (const s of A) if (B.has(s)) both++;
  return both / (A.size + B.size - both);
}

/** Which positions of `a` are outside a longest common subsequence with `b`. */
function unmatched(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const miss = new Set();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) miss.add(i++);
    else j++;
  }
  while (i < n) miss.add(i++);
  return miss;
}

const MAX_LITERAL_SHARE_FOR_L1 = 0.35;
const NEAR = 0.8;

const PRESETS = {
  format: [
    `function total(items) {
  let sum = 0;
  for (const item of items) {
    sum += item.price * item.qty;
  }
  return sum;
}`,
    `function total(items) {
  // add it all up
  let sum = 0;
  for (const item of items) { sum += item.price * item.qty; }
  return sum;
}`,
  ],
  renamed: [
    `function total(items) {
  let sum = 0;
  for (const item of items) {
    sum += item.price * item.qty;
  }
  return sum;
}`,
    `function orderTotal(lines) {
  let acc = 0;
  for (const line of lines) {
    acc += line.cost * line.count;
  }
  return acc;
}`,
  ],
  constant: [
    `const user = await retry(() => api.get("/users/" + id), {
  attempts: 3,
  delayMs: 250,
});`,
    `const user = await retry(() => api.get("/users/" + id), {
  attempts: 5,
  delayMs: 1000,
});`,
  ],
  labels: [
    `const STATUS_LABELS = {
  draft: "Draft",
  sent: "Sent",
  failed: "Failed",
};`,
    `const ROLE_LABELS = {
  admin: "Administrator",
  guest: "Guest",
  owner: "Owner",
};`,
  ],
  extra: [
    `function toRow(user) {
  if (!user.active) return null;
  const name = user.first + " " + user.last;
  return {
    id: user.id,
    name: name.trim(),
    email: user.email.toLowerCase(),
    team: user.team.name,
    city: user.address.city,
    joined: formatDate(user.createdAt),
  };
}`,
    `function toRow(member) {
  if (!member.active) return null;
  const name = member.first + " " + member.last;
  return {
    id: member.id,
    name: name.trim(),
    email: member.email.toLowerCase(),
    team: member.team.name,
    city: member.address.city,
    joined: formatDate(member.createdAt),
    isAdmin: member.role === "admin",
  };
}`,
  ],
  different: [
    `function total(items) {
  let sum = 0;
  for (const item of items) {
    sum += item.price * item.qty;
  }
  return sum;
}`,
    `async function loadUser(id) {
  const res = await fetch("/api/users/" + id);
  if (!res.ok) throw new Error("not found");
  return res.json();
}`,
  ],
};

function fpDemo() {
  const root = $("#fp-demo");
  if (!root) return;
  const a = $("#fp-a");
  const b = $("#fp-b");
  let mode = "l1";

  const chips = (s, other, el) => {
    const stream = s[mode];
    const miss = unmatched(stream, other[mode]);
    el.innerHTML = stream
      .map((v, i) => `<span class="chip ${s.tokens[i].t}${miss.has(i) ? " miss" : ""}">${esc(v)}</span>`)
      .join("");
  };

  const pct = (x) => `${Math.round(x * 100)}%`;

  const render = () => {
    const A = streams(tokenize(a.value));
    const B = streams(tokenize(b.value));
    chips(A, B, $("#fp-a-stream"));
    chips(B, A, $("#fp-b-stream"));

    const same = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
    const j = jaccard(A.l2, B.l2);
    const eligible = A.literalShare < MAX_LITERAL_SHARE_FOR_L1 && B.literalShare < MAX_LITERAL_SHARE_FOR_L1;
    let cls;
    let head;
    let body;
    if (A.l0.length === 0 || B.l0.length === 0) {
      cls = "none";
      head = "Nothing to compare";
      body = "Type some code on both sides.";
    } else if (same(A.l0, B.l0)) {
      cls = "l0";
      head = "Exact copy · L0";
      body = "Same tokens, same names, same values. Formatting and comments don't count.";
    } else if (same(A.l1, B.l1) && eligible) {
      cls = "l1";
      head = "Renamed copy · L1";
      body = "Different at L0, but the same code once names are numbered and values are dropped.";
    } else if (same(A.l1, B.l1)) {
      cls = "data";
      head = "Same shape, different data · no match";
      const worst = Math.max(A.literalShare, B.literalShare);
      body =
        `They match at L1, but ${pct(worst)} of the names and values are literals. ` +
        `Over 35%, a fragment can only match at L0, so these count as two different tables.`;
    } else if (j >= NEAR) {
      cls = "near";
      head = `Near copy · ${pct(j)} alike`;
      body = "No exact match at either level. But 80% or more of the 5-token runs agree, so B gets listed as a near copy of A.";
    } else {
      cls = "none";
      head = `No match · ${pct(j)} alike`;
      body = "A near copy needs at least 80% of its 5-token runs to agree.";
    }
    $("#fp-verdict").className = `verdict ${cls}`;
    $("#fp-verdict").innerHTML =
      `<strong>${head}</strong><span>${body}</span>` +
      `<small>literal share A ${pct(A.literalShare)} · B ${pct(B.literalShare)} · 5-token runs in common ${pct(j)}</small>`;
  };

  buttonGroup(root, "preset", (key) => {
    [a.value, b.value] = PRESETS[key];
    render();
  })("renamed");
  buttonGroup($(".fp-mode", root), "mode", (key) => {
    mode = key;
    render();
  });
  a.addEventListener("input", render);
  b.addEventListener("input", render);
}

/* ---- 3a. a concrete chain --------------------------------------------- */

const TO_ROW_COMMON = [
  "    url: \"/users/\" + user.id,",
  "    avatar: avatarUrl(user.id, 64),",
  "    plan: PLANS[user.planId].label,",
  "    lastSeen: user.sessions[0]?.at ?? null,",
  "    joined: formatDate(user.createdAt),",
];
const TO_ROW = (() => {
  const id = "    id: user.id,";
  const name = "    name: user.name.trim(),";
  const email = "    email: user.email.toLowerCase(),";
  const admin = "    isAdmin: user.role === \"admin\",";
  const seats = "    seats: user.seats.filter(isActive).length,";
  const tags = "    tags: user.tags.map(String),";
  return [
    [id, name, email, ...TO_ROW_COMMON],
    [id, name, ...TO_ROW_COMMON, admin],
    [id, name, ...TO_ROW_COMMON, admin, seats],
    [id, ...TO_ROW_COMMON, admin, seats, tags],
  ];
})();
const toRowSource = (fields) =>
  ["function toRow(user) {", "  if (!user.active) return null;", "  return {", ...fields, "  };", "}"].join("\n");

function driftChainDemo() {
  const root = $("#drift-chain-demo");
  if (!root) return;
  const names = ["A", "B", "C", "D"];
  const sketches = TO_ROW.map((f) => streams(tokenize(toRowSource(f))).l2);
  const sim = (i, j) => jaccard(sketches[i], sketches[j]);
  const pct = (x) => `${Math.round(x * 100)}%`;

  const groupsFor = (rule) => {
    const group = [-1, -1, -1, -1];
    const centers = new Set();
    if (rule === "union") return { group: [0, 0, 0, 0], centers };
    let next = 0;
    // A ranks highest, then B, C, D.
    for (let c = 0; c < 4; c++) {
      if (group[c] !== -1) continue;
      group[c] = next;
      centers.add(c);
      for (let m = 0; m < 4; m++) if (group[m] === -1 && sim(c, m) >= NEAR) group[m] = next;
      next++;
    }
    return { group, centers };
  };

  const draw = (rule) => {
    const { group, centers } = groupsFor(rule);
    $(".dchain-cards", root).innerHTML = TO_ROW.map((fields, i) => {
      const prev = i === 0 ? null : new Set(TO_ROW[i - 1]);
      const removed = i === 0 ? [] : TO_ROW[i - 1].filter((l) => !fields.includes(l));
      const added = i === 0 ? [] : fields.filter((l) => !TO_ROW[i - 1].includes(l));
      const key = (l) => `<code>${esc(l.trim().split(":")[0])}</code>`;
      const lines = toRowSource(fields)
        .split("\n")
        .map((l) => (prev && fields.includes(l) && !prev.has(l) ? `<span class="added">${esc(l)}</span>` : esc(l)))
        .join("\n");
      const changes = [
        added.length ? `added ${added.map(key).join(", ")}` : "",
        removed.length ? `removed ${removed.map(key).join(", ")}` : "",
      ].filter(Boolean);
      const gone = `<div class="removed">${i === 0 ? "the original" : `vs ${names[i - 1]}: ${changes.join(" · ")}`}</div>`;
      const link = i === 0 ? "" : `<span class="dchain-sim">${pct(sim(i - 1, i))} like ${names[i - 1]}</span>`;
      return `<div class="dchain-card grp${group[i]}">
        <div class="dchain-head"><strong>${names[i]}</strong>${centers.has(i) ? '<span class="badge">center</span>' : ""}${link}</div>
        <pre><code>${lines}</code></pre>${gone}</div>`;
    }).join("");
    const ad = pct(sim(0, 3));
    const ac = pct(sim(0, 2));
    $(".dchain-caption", root).innerHTML =
      rule === "union"
        ? `One group. A and D are only ${ad} alike, but B and C link them, so they end up together anyway.`
        : `Two groups. Say A ranks highest, so A is the first center. It claims B. C is only ${ac} like A, so C starts its own group and claims D.`;
  };
  buttonGroup(root, "dchain", draw)("union");
}

/* ---- 3. near copies don't chain --------------------------------------- */

function chainDemo() {
  const root = $("#chain-demo");
  if (!root) return;
  const svg = $("svg", root);
  // Rank 1 is best. Positions wind left to right so the chain reads as one.
  const ranks = [6, 3, 9, 1, 7, 5, 8, 2, 4];
  const nodes = ranks.map((rank, i) => ({
    i,
    rank,
    x: 45 + i * 69,
    y: 110 + Math.round(Math.sin(i * 1.3) * 60),
    r: 9 + (10 - rank) * 1.6,
  }));
  const edges = [
    [0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [1, 3], [5, 7],
  ];
  const near = (x, y) => edges.some(([p, q]) => (p === x && q === y) || (p === y && q === x));

  const groupsFor = (rule) => {
    const group = new Array(nodes.length).fill(-1);
    const centers = new Set();
    if (rule === "union") {
      group.fill(0);
      return { group, centers, count: 1 };
    }
    let count = 0;
    for (const n of [...nodes].sort((p, q) => p.rank - q.rank)) {
      if (group[n.i] !== -1) continue;
      group[n.i] = count;
      centers.add(n.i);
      for (const m of nodes) if (group[m.i] === -1 && near(n.i, m.i)) group[m.i] = count;
      count++;
    }
    return { group, centers, count };
  };

  const draw = (rule) => {
    const { group, centers, count } = groupsFor(rule);
    const lines = edges
      .map(([p, q]) => {
        const kept = rule === "union" || (group[p] === group[q] && (centers.has(p) || centers.has(q)));
        return `<line x1="${nodes[p].x}" y1="${nodes[p].y}" x2="${nodes[q].x}" y2="${nodes[q].y}" class="${kept ? "edge kept" : "edge"}"/>`;
      })
      .join("");
    const dots = nodes
      .map(
        (n) =>
          `<g class="dot g${group[n.i] % 6}${centers.has(n.i) ? " center" : ""}">` +
          `<circle cx="${n.x}" cy="${n.y}" r="${n.r}"/>` +
          `<text x="${n.x}" y="${n.y + 4}">${n.rank}</text></g>`,
      )
      .join("");
    const ends =
      `<text class="note" x="${nodes[0].x}" y="${nodes[0].y + 36}">A</text>` +
      `<text class="note" x="${nodes[8].x}" y="${nodes[8].y + 38}">Z</text>`;
    svg.innerHTML = lines + dots + ends;
    $("#chain-caption", root).textContent =
      rule === "union"
        ? "One group of 9. Each neighbor is near the next, so A ends up grouped with Z, and they share almost nothing."
        : `${count} groups, centered on findings ${[...centers]
            .map((i) => nodes[i].rank)
            .sort((p, q) => p - q)
            .join(", ")
            .replace(/, (\d+)$/, " and $1")}. ` +
          "Finding 1 claims its direct neighbors first. Then the best-ranked finding that's still unclaimed does the same. A finding only joins a group if it's near the center.";
  };

  buttonGroup(root, "chain", draw)("union");
}

/* ---- 4. nested repeats ------------------------------------------------- */

function nestDemo() {
  const root = $("#nest-demo");
  if (!root) return;
  const files = [
    { name: "alpha.ts", line: 4, outer: "normalize()" },
    { name: "beta.ts", line: 3, outer: "normalize()" },
    { name: "gamma.ts", line: 9, outer: "normalize()" },
    { name: "setup.ts", line: 12, outer: "resetPoints()" },
  ];
  const draw = (step) => {
    const after = step === "after";
    $(".nest-files", root).innerHTML = files
      .map((f) => {
        const copy = f.outer === "normalize()";
        const fn = copy ? "f-fn" : "f-other";
        const block = copy ? (after ? "f-gone" : "f-block") : "f-other";
        const loop = copy ? (after ? "f-gone" : "f-loop") : after ? "f-also" : "f-loop";
        return `<div class="nest-file"><div class="nest-name">${f.name}</div>
          <div class="box ${fn}"><span>function ${f.outer}</span>
            <div class="box ${block}"><span>body { }</span>
              <div class="box ${loop}"><span>for (…) { }</span></div>
            </div>
          </div></div>`;
      })
      .join("");
    $(".nest-report", root).innerHTML = after
      ? `<div class="finding f-fn">function · 3 copies</div>
         <div class="finding-note">same shape in other surroundings: <code>setup.ts:12</code></div>`
      : `<div class="finding f-fn">function · 3 copies</div>
         <div class="finding f-block">body · 3 copies</div>
         <div class="finding f-loop">loop · 4 copies</div>`;
  };
  buttonGroup(root, "nest", draw)("before");
}

/* ---- 5. ranking -------------------------------------------------------- */

const COUNT_EXPONENT = { L0: 0.9, L1: 0.6 };
const LEVEL_WEIGHT = { L0: 1, L1: 0.9 };
const SPREAD = { crossModule: 2.5, crossFile: 1.4, intraFile: 0.8 };
const SPREAD_LABEL = { crossModule: "across modules", crossFile: "across files", intraFile: "in one file" };
/** The demo talks in lines. thicket counts syntax nodes. */
const NODES_PER_LINE = 7;

const RANK_PRESETS = {
  tiny: [
    { copies: 50, lines: 4, level: "L1", spread: "crossFile" },
    { copies: 2, lines: 100, level: "L0", spread: "crossFile" },
  ],
  rename: [
    { copies: 8, lines: 12, level: "L0", spread: "crossFile" },
    { copies: 8, lines: 12, level: "L1", spread: "crossFile" },
  ],
  spread: [
    { copies: 6, lines: 15, level: "L0", spread: "intraFile" },
    { copies: 4, lines: 15, level: "L0", spread: "crossModule" },
  ],
};

function rankDemo() {
  const root = $("#rank-demo");
  if (!root) return;
  const state = RANK_PRESETS.tiny.map((f) => ({ ...f }));
  const score = (f) =>
    (f.lines * NODES_PER_LINE) ** 1.5 * (f.copies - 1) ** COUNT_EXPONENT[f.level] * LEVEL_WEIGHT[f.level] * SPREAD[f.spread];
  const naive = (f) => (f.copies - 1) * (f.lines - 1);

  const cards = $(".rank-cards", root);
  const cardHtml = (f, k) => `
    <fieldset class="rank-card r${k}">
      <legend>Finding ${"AB"[k]}</legend>
      <label>Copies <output data-o="copies">${f.copies}</output>
        <input type="range" min="2" max="60" value="${f.copies}" data-k="${k}" data-f="copies"></label>
      <label>Lines per copy <output data-o="lines">${f.lines}</output>
        <input type="range" min="2" max="120" value="${f.lines}" data-k="${k}" data-f="lines"></label>
      <div class="seg">
        ${["L0", "L1"].map((l) => `<button type="button" data-k="${k}" data-f="level" data-v="${l}" aria-pressed="${f.level === l}">${l === "L0" ? "exact" : "renamed"}</button>`).join("")}
      </div>
      <div class="seg">
        ${Object.keys(SPREAD).map((s) => `<button type="button" data-k="${k}" data-f="spread" data-v="${s}" aria-pressed="${f.spread === s}">${SPREAD_LABEL[s]}</button>`).join("")}
      </div>
    </fieldset>`;

  const bars = () => {
    const rows = [
      ["Lines saved", state.map(naive)],
      ["thicket score", state.map(score)],
    ];
    $(".rank-bars", root).innerHTML = rows
      .map(([title, vals]) => {
        const max = Math.max(...vals, 1);
        const win = vals[0] === vals[1] ? -1 : vals[0] > vals[1] ? 0 : 1;
        return `<div class="bar-group"><div class="bar-title">${title}</div>${vals
          .map(
            (v, k) =>
              `<div class="bar-row"><span class="bar-key">${"AB"[k]}</span><span class="bar r${k}" style="width:${Math.max(2, (v / max) * 100)}%"></span><span class="bar-val">${Math.round(v).toLocaleString("en-US")}${win === k ? " ← wins" : ""}</span></div>`,
          )
          .join("")}</div>`;
      })
      .join("");
  };

  const full = () => {
    cards.innerHTML = state.map(cardHtml).join("");
    bars();
  };

  cards.addEventListener("input", (e) => {
    const t = e.target;
    if (t.type !== "range") return;
    state[t.dataset.k][t.dataset.f] = Number(t.value);
    $(`[data-o="${t.dataset.f}"]`, t.closest("fieldset")).textContent = t.value;
    bars();
  });
  cards.addEventListener("click", (e) => {
    const t = e.target.closest("button[data-f]");
    if (!t) return;
    state[t.dataset.k][t.dataset.f] = t.dataset.v;
    full();
  });
  buttonGroup(root, "rank", (key) => {
    RANK_PRESETS[key].forEach((f, k) => Object.assign(state[k], f));
    full();
  })("tiny");
}

/* ---- 6. field-name drift ---------------------------------------------- */

const DRIFT_FLOOR = 0.25;

// Each copy is a list of [field, value] pairs. Field names are what drift.
const DRIFT = {
  values: {
    lang: "ts",
    copies: [
      ["usd", "defineCurrency", [["code", '"USD"'], ["symbol", '"$"'], ["round", "toCents"], ["parse", "parseDecimal"]]],
      ["jpy", "defineCurrency", [["code", '"JPY"'], ["symbol", '"¥"'], ["round", "toWhole"], ["parse", "parseDecimal"]]],
      ["eur", "defineCurrency", [["code", '"EUR"'], ["symbol", '"€"'], ["round", "toCents"], ["parse", "parseComma"]]],
    ],
    say: "Every copy has the same four fields. Only the values change. That's one idea with settings: a table of currencies.",
  },
  keys: {
    lang: "ts",
    copies: [
      ["summary", "", [["id", "user.id"], ["name", "user.name"], ["plan", "user.plan"]]],
      ["header", "", [["title", "post.title"], ["author", "post.by"], ["date", "post.at"]]],
      ["badge", "", [["label", "tag.text"], ["color", "tag.hue"], ["count", "tag.uses"]]],
    ],
    say: "Same shape at L1: three keys, each one reading a property. But no field name repeats. These are three different objects. A helper that builds all three would just be a worse object literal.",
  },
  jsx: {
    lang: "jsx",
    copies: [
      ["p", "", [["role", '"status"'], ["className", "{styles.note}"]]],
      ["Badge", "", [["variant", '"outline"'], ["className", "{styles.tag}"]]],
      ["span", "", [["title", '"Saved"'], ["className", "{styles.hint}"]]],
    ],
    say: "One attribute is shared and one isn't. Half the field names drift, so the score keeps a bit more than half.",
  },
};

function driftDemo() {
  const root = $("#drift-demo");
  if (!root) return;
  let current = "values";
  let ignoreJsx = false;

  const render = () => {
    const ex = DRIFT[current];
    const n = ex.copies[0][2].length;
    const varies = [];
    for (let i = 0; i < n; i++) varies.push(ex.copies.some((c) => c[2][i][0] !== ex.copies[0][2][i][0]));
    const blind = ex.lang === "jsx" && ignoreJsx;
    const total = blind ? 0 : n;
    const varying = blind ? 0 : varies.filter(Boolean).length;
    const weight = total === 0 ? 1 : 1 - (1 - DRIFT_FLOOR) * (varying / total);

    const field = (name, i) => `<span class="field${!blind && varies[i] ? " drifts" : ""}${blind ? " unseen" : ""}">${esc(name)}</span>`;
    $(".drift-copies", root).innerHTML = ex.copies
      .map(([name, call, fields]) => {
        if (ex.lang === "jsx") {
          const attrs = fields.map(([k, v], i) => ` ${field(k, i)}=${esc(v)}`).join("");
          return `<pre><code>&lt;${esc(name)}${attrs}&gt;…&lt;/${esc(name)}&gt;</code></pre>`;
        }
        const body = fields.map(([k, v], i) => `  ${field(k, i)}: ${esc(v)},`).join("\n");
        const open = call ? `${esc(call)}({` : "{";
        const close = call ? "})" : "}";
        return `<pre><code>const ${esc(name)} = ${open}\n${body}\n${close};</code></pre>`;
      })
      .join("");

    const toggle =
      ex.lang === "jsx"
        ? `<label class="check"><input type="checkbox" ${ignoreJsx ? "checked" : ""}> Ignore JSX attribute names</label>`
        : "";
    const say = blind
      ? "With attribute names ignored, there are no field names to compare. Drift reads as zero, and the finding keeps its full score. Zero here means nothing was measured."
      : ex.say;
    $(".drift-meter", root).innerHTML = `
      <div class="meter-row">
        <span>field names that drift: <strong>${varying} of ${total}</strong></span>
        <span>score kept: <strong>${Math.round(weight * 100)}%</strong></span>
      </div>
      <div class="meter"><span style="width:${weight * 100}%"></span></div>
      <p>${say}</p>${toggle}`;
    const box = $("input[type=checkbox]", root);
    if (box)
      box.addEventListener("change", () => {
        ignoreJsx = box.checked;
        render();
      });
  };

  buttonGroup(root, "drift", (key) => {
    current = key;
    render();
  })("values");
}

/* ---- 10. tangles ------------------------------------------------------- */

function tangleDemo() {
  const root = $("#tangle-demo");
  if (!root) return;
  const svg = $("svg", root);
  const N = {
    ui: { x: 110, y: 70, label: "ui/" },
    lib: { x: 450, y: 70, label: "lib/" },
    shared: { x: 280, y: 190, label: "shared/" },
  };
  const arrow = (from, to, cls, text, bend = 0) => {
    const a = N[from];
    const b = N[to];
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2 + bend;
    // Stop short of the box so the arrowhead stays visible.
    const dx = b.x - mx;
    const dy = b.y - my;
    const len = Math.hypot(dx, dy);
    const ex = b.x - (dx / len) * 46;
    const ey = b.y - (dy / len) * 24;
    return `<path class="arr ${cls}" d="M${a.x},${a.y} Q${mx},${my} ${ex},${ey}" marker-end="url(#head-${cls})"/>
      <text class="arr-label ${cls}" x="${mx}" y="${(a.y + b.y) / 2 + bend / 2 + (bend < 0 ? -8 : bend > 0 ? 18 : -8)}">${text}</text>`;
  };
  const draw = (step) => {
    const after = step === "after";
    const defs = `<defs>${["live", "forward", "fixed"]
      .map((c) => `<marker id="head-${c}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="head ${c}" d="M0,0 L10,5 L0,10 z"/></marker>`)
      .join("")}</defs>`;
    const edges = [
      after
        ? arrow("ui", "shared", "fixed", "formatDate")
        : arrow("ui", "lib", "forward", "formatDate, via lib/index.ts", -50),
      arrow("lib", "ui", "live", "useTheme", 50),
      arrow("lib", "shared", "live", "export … from"),
    ].join("");
    const cycle = !after;
    const boxes = Object.entries(N)
      .map(
        ([k, n]) =>
          `<g class="mod${cycle && k !== "shared" ? " in-cycle" : ""}"><rect x="${n.x - 44}" y="${n.y - 20}" width="88" height="40" rx="8"/><text x="${n.x}" y="${n.y + 5}">${n.label}</text></g>`,
      )
      .join("");
    svg.innerHTML = defs + edges + boxes;
    $("#tangle-caption", root).textContent = after
      ? "ui/ now imports formatDate from where it really lives. The ui/ → lib/ edge is gone, and so is the cycle. Same program, one find-and-replace."
      : "ui/ and lib/ import each other, so they're a tangle. But ui/ only reaches lib/ for formatDate, and lib/ just re-exports that from shared/.";
  };
  buttonGroup(root, "tangle", draw)("before");
}

/* ---- 10a. choosing a cut ---------------------------------------------- */

const CUT_NODES = {
  ui: [270, 40], api: [410, 125], auth: [355, 255], db: [185, 255], util: [130, 125], jobs: [510, 40],
};
const CUT_EDGES = [
  ["ui", "api", 12], ["api", "auth", 5], ["auth", "db", 8], ["db", "util", 4], ["util", "ui", 3],
  ["jobs", "api", 4], ["api", "jobs", 1],
];
const MAX_RESIDUAL_SHARE = 2 / 3;

/** Strongly connected components with two or more members. Tarjan. */
function tangles(nodes, edges) {
  const index = new Map();
  const low = new Map();
  const stack = [];
  const on = new Set();
  const out = [];
  let i = 0;
  const visit = (v) => {
    index.set(v, i);
    low.set(v, i++);
    stack.push(v);
    on.add(v);
    for (const [from, to] of edges) {
      if (from !== v) continue;
      if (!index.has(to)) {
        visit(to);
        low.set(v, Math.min(low.get(v), low.get(to)));
      } else if (on.has(to)) low.set(v, Math.min(low.get(v), index.get(to)));
    }
    if (low.get(v) === index.get(v)) {
      const comp = [];
      let w;
      do {
        w = stack.pop();
        on.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1) out.push(comp.sort());
    }
  };
  for (const v of nodes) if (!index.has(v)) visit(v);
  return out;
}

function cutDemo() {
  const root = $("#cut-demo");
  if (!root) return;
  const svg = $("svg", root);
  const nodes = Object.keys(CUT_NODES);
  const name = (e) => `${e[0]} → ${e[1]}`;
  const largest = (cut) => {
    const left = CUT_EDGES.filter((_, k) => !cut.has(k));
    const comps = tangles(nodes, left);
    return { comps, size: Math.max(0, ...comps.map((c) => c.length)) };
  };
  // thicket's rule: smallest tangle left, then cheapest, then name.
  const scored = CUT_EDGES.map((e, k) => ({ k, e, left: largest(new Set([k])).size }));
  const best = [...scored].sort(
    (a, b) => a.left - b.left || a.e[2] - b.e[2] || (name(a.e) < name(b.e) ? -1 : 1),
  )[0];
  const cheapest = [...scored].sort((a, b) => a.e[2] - b.e[2])[0];
  let cut = new Set();

  const draw = () => {
    const { comps, size } = largest(cut);
    const tangled = new Set(comps.flat());
    const edges = CUT_EDGES.map((e, k) => {
      let [x1, y1] = CUT_NODES[e[0]];
      let [x2, y2] = CUT_NODES[e[1]];
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.hypot(dx, dy);
      const ux = dx / len;
      const uy = dy / len;
      // Two edges between one pair sit side by side.
      const pair = CUT_EDGES.some((f) => f[0] === e[1] && f[1] === e[0]);
      const ox = pair ? -uy * 8 : 0;
      const oy = pair ? ux * 8 : 0;
      const pad = (ux2, uy2) => Math.min(44 / Math.abs(ux2 || 1e-9), 22 / Math.abs(uy2 || 1e-9)) + 4;
      const p = pad(ux, uy);
      x1 += ux * p + ox;
      y1 += uy * p + oy;
      x2 -= ux * p - ox;
      y2 -= uy * p - oy;
      const mx = (x1 + x2) / 2 - uy * (pair ? 14 : 12);
      const my = (y1 + y2) / 2 + ux * (pair ? 14 : 12);
      const cls = cut.has(k) ? "cut" : "live";
      return `<g class="cedge ${cls}" data-e="${k}">
        <line class="hit" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>
        <line class="arr ${cls}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" marker-end="url(#chead-${cls})"/>
        <text class="clabel" x="${mx}" y="${my + 4}">${cut.has(k) ? "✂ " : ""}${e[2]}</text></g>`;
    }).join("");
    const defs = `<defs>${["live", "cut"]
      .map((c) => `<marker id="chead-${c}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="head ${c}" d="M0,0 L10,5 L0,10 z"/></marker>`)
      .join("")}</defs>`;
    const boxes = nodes
      .map((n) => {
        const [x, y] = CUT_NODES[n];
        return `<g class="mod${tangled.has(n) ? " in-cycle" : ""}"><rect x="${x - 40}" y="${y - 18}" width="80" height="36" rx="8"/><text x="${x}" y="${y + 5}">${n}/</text></g>`;
      })
      .join("");
    svg.innerHTML = defs + edges + boxes;

    const verdict = $("#cut-verdict", root);
    const total = nodes.length;
    const listed = (c) =>
      c
        .map((m) => `${m}/`)
        .join(", ")
        .replace(/, ([^,]+)$/, " and $1");
    const biggest = comps.find((c) => c.length === size);
    let cls = "none";
    let head;
    let body;
    if (cut.size === 0) {
      head = `All ${total} modules are tangled`;
      body = "Every module can reach every other one through some chain of imports.";
    } else if (cut.size > 1) {
      const cost = [...cut].reduce((n, k) => n + CUT_EDGES[k][2], 0);
      head = size === 0 ? "No tangle left" : `Largest tangle left: ${size} of ${total}`;
      body = `You've cut ${cut.size} edges, ${cost} imports in all. thicket only suggests one cut at a time, so try a single edge.`;
    } else {
      const k = [...cut][0];
      const e = CUT_EDGES[k];
      const isBest = k === best.k;
      head = size === 0 ? `Cut ${name(e)}: no tangle left` : `Cut ${name(e)}: ${size} of ${total} still tangled`;
      if (size / total > MAX_RESIDUAL_SHARE) {
        cls = "none";
        body = `That leaves ${listed(biggest)} tangled. That's more than two thirds of the tangle, so thicket won't suggest it, however cheap it is.`;
      } else if (isBest) {
        cls = "l1";
        body =
          (size === 0 ? "It breaks the cycle outright. " : `Only ${listed(biggest)} are still tangled, which is a much smaller job. `) +
          `Other edges leave the same, but this one moves the fewest imports (${e[2]}). This is thicket's pick.`;
      } else {
        cls = "data";
        body = `That's good enough to suggest. But ${name(best.e)} leaves the same and moves only ${best.e[2]} imports, so thicket picks that one.`;
      }
    }
    verdict.className = `verdict ${cls}`;
    verdict.innerHTML = `<strong>${head}</strong><span>${body}</span>`;
  };

  svg.addEventListener("click", (e) => {
    const g = e.target.closest(".cedge");
    if (!g) return;
    const k = Number(g.dataset.e);
    if (cut.has(k)) cut.delete(k);
    else cut.add(k);
    draw();
  });
  for (const b of $$("[data-cut]", root))
    b.addEventListener("click", () => {
      const act = b.dataset.cut;
      cut = act === "reset" ? new Set() : new Set([act === "pick" ? best.k : cheapest.k]);
      draw();
    });
  draw();
}

fragDemo();
astDemo();
fpDemo();
driftChainDemo();
chainDemo();
nestDemo();
rankDemo();
driftDemo();
tangleDemo();
cutDemo();
