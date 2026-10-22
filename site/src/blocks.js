// What a page says, as a list of text blocks, so two versions can be compared and a decision can be tied to the words it was made on.
// No heavy libraries: a small tokenizer over the HTML text (it runs the same on every runtime), then a simple diff over block hashes.
//
// A block is a run of text between two block-level tags: a paragraph, a heading, a list item, a table cell, a caption, a line of a diagram.
// A section is an element that carries data-redline-decision="<id>"; its hash covers every block inside it.

const BLOCK_TAGS = new Set((
  "address article aside blockquote body caption dd details dialog div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup " +
  "hr html li main menu nav ol p pre section summary table tbody td tfoot th thead tr ul svg text"
).split(" "));
const SKIP_TAGS = new Set(["head", "script", "style", "template", "noscript", "textarea", "title"]);
const VOID_TAGS = new Set("area base br col embed hr img input link meta source track wbr".split(" "));

const MAX_HTML_CHARS = 2_000_000;
const MAX_BLOCKS = 5000;
const KEEP_CHARS = 240;

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", lsquo: "‘", rsquo: "’",
  ldquo: "“", rdquo: "”", copy: "©", middot: "·", bull: "•", times: "×", rarr: "→", larr: "←", laquo: "«", raquo: "»",
};

function decode(s) {
  if (s.indexOf("&") < 0) return s;
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]{1,8});/gi, (all, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : all;
    }
    const v = ENTITIES[e.toLowerCase()];
    return v === undefined ? all : v;
  });
}

export const normalize = (s) => s.replace(/[\s ​-‍﻿]+/g, " ").trim();

// A 53-bit string hash (cyrb53), written as base 36. Fast, and plenty for telling two paragraphs apart.
export function hashText(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// Letters and digits only, lower case: how a block is recognised across small differences in spacing, quotes and punctuation.
export const looseKey = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

// { blocks: [{h, t}], sections: { id: hash }, doc: hash } for one page, or null when the page is too large to read cheaply.
export function extractBlocks(html) {
  if (typeof html !== "string" || html.length > MAX_HTML_CHARS) return null;
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|<[!?][^>]*>|[^<]+|</g;
  const blocks = [];
  const stack = [];
  const open = [];
  const sections = {};
  let buf = "";

  const flush = () => {
    if (!buf) return;
    const t = normalize(decode(buf));
    buf = "";
    if (t && blocks.length < MAX_BLOCKS) blocks.push({ h: hashText(t), t });
  };
  const closeSections = (depth) => {
    while (open.length && open[open.length - 1].depth >= depth) {
      const s = open.pop();
      if (!(s.id in sections)) sections[s.id] = hashText(blocks.slice(s.start).map((b) => b.h).join(","));
    }
  };

  let m;
  while ((m = re.exec(html))) {
    const tag = m[2];
    if (tag === undefined) {
      if (m[0][0] !== "<" || m[0] === "<") buf += m[0]; // text; comments, CDATA and doctype were matched whole and are dropped
      continue;
    }
    const name = tag.toLowerCase();
    if (!m[1]) {
      if (SKIP_TAGS.has(name) && !/\/\s*$/.test(m[3])) {
        const end = new RegExp("</" + name + "\\s*>", "ig");
        end.lastIndex = re.lastIndex;
        const found = end.exec(html);
        re.lastIndex = found ? end.lastIndex : html.length;
        continue;
      }
      const block = BLOCK_TAGS.has(name);
      if (block) flush();
      const attr = /\sdata-redline-decision\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[3]);
      const selfClosed = /\/\s*$/.test(m[3]);
      if (attr) {
        const id = (attr[1] ?? attr[2] ?? attr[3] ?? "").trim().slice(0, 80);
        if (id) open.push({ id, depth: stack.length + 1, start: blocks.length });
      }
      if (!VOID_TAGS.has(name) && !selfClosed) stack.push(name);
      else if (attr && open.length) closeSections(stack.length + 1);
    } else {
      if (BLOCK_TAGS.has(name)) flush();
      let at = -1;
      for (let i = stack.length - 1; i >= 0; i--) if (stack[i] === name) { at = i; break; }
      if (at >= 0) {
        stack.length = at;
        closeSections(at + 1);
      }
    }
  }
  flush();
  closeSections(0);
  const doc = hashText(blocks.map((b) => b.h).join(","));
  return { blocks, sections, doc };
}

// How the words in a block overlap another block's, 0 to 1.
const words = (t) => new Set(t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
function similarity(a, b) {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

const clip = (t) => (t.length > KEEP_CHARS ? t.slice(0, KEEP_CHARS - 1) + "…" : t);

// What changed from `prev` to `cur` (both lists of {h, t}).
//   items:   blocks of `cur` that are new ("new") or replace a block of `prev` ("changed", with `w`, the words that were there)
//   removed: blocks of `prev` that have no counterpart in `cur`
// Common blocks at both ends are skipped, then a longest-common-subsequence over the block hashes finds the rest. Pages too large for that
// are compared as sets, which is less exact but cannot be slow.
export function diffBlocks(prev, cur) {
  let top = 0;
  while (top < prev.length && top < cur.length && prev[top].h === cur[top].h) top++;
  let endPrev = prev.length, endCur = cur.length;
  while (endPrev > top && endCur > top && prev[endPrev - 1].h === cur[endCur - 1].h) { endPrev--; endCur--; }
  const a = prev.slice(top, endPrev), b = cur.slice(top, endCur);

  // gaps: runs of blocks that are only in `a` (dels) or only in `b` (ins), in page order.
  const gaps = [];
  if (a.length * b.length <= 4_000_000) {
    const w = b.length + 1;
    const table = new Uint16Array((a.length + 1) * w);
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        table[i * w + j] = a[i].h === b[j].h ? table[(i + 1) * w + j + 1] + 1 : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
      }
    }
    let i = 0, j = 0, gap = { dels: [], ins: [] };
    const close = () => { if (gap.dels.length || gap.ins.length) gaps.push(gap); gap = { dels: [], ins: [] }; };
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i].h === b[j].h) { close(); i++; j++; }
      else if (j < b.length && (i === a.length || table[i * w + j + 1] >= table[(i + 1) * w + j])) gap.ins.push(b[j++]);
      else gap.dels.push(a[i++]);
    }
    close();
  } else {
    const had = new Set(a.map((x) => x.h)), has = new Set(b.map((x) => x.h));
    gaps.push({ dels: a.filter((x) => !has.has(x.h)), ins: b.filter((x) => !had.has(x.h)) });
  }

  // A block that only moved (the same words in a different place) is neither new nor removed: its two halves cancel out.
  const gone = new Map();
  for (const g of gaps) for (const d of g.dels) (gone.get(d.h) || gone.set(d.h, []).get(d.h)).push(d);
  const moved = new Set();
  for (const g of gaps) g.ins = g.ins.filter((x) => { const list = gone.get(x.h); if (!list || !list.length) return true; moved.add(list.pop()); return false; });
  for (const g of gaps) g.dels = g.dels.filter((d) => !moved.has(d));

  const items = [], removed = [];
  for (const g of gaps) {
    const free = g.dels.map(() => true);
    const lone = g.dels.length === 1 && g.ins.length === 1;
    for (const ins of g.ins) {
      let best = -1, bestScore = 0;
      for (let k = 0; k < g.dels.length; k++) {
        if (!free[k]) continue;
        const s = similarity(g.dels[k].t, ins.t);
        if (s > bestScore) { best = k; bestScore = s; }
      }
      if (best < 0 && lone) best = 0;
      if (best >= 0 && (bestScore >= 0.3 || lone)) {
        free[best] = false;
        items.push({ t: clip(ins.t), k: "changed", w: clip(g.dels[best].t), h: ins.h });
      } else {
        items.push({ t: clip(ins.t), k: "new", h: ins.h });
      }
    }
    g.dels.forEach((d, k) => { if (free[k]) removed.push({ t: clip(d.t) }); });
  }
  // Items come out in page order only within each gap, and the gaps are in order, so the whole list is in page order.
  return { items, removed };
}

// The block of a page that a pen mark was drawn on, found by the first words of its text (the page keeps up to 80 characters of them).
export function findAnchorBlock(blocks, anchorText) {
  const key = looseKey(anchorText).slice(0, 60);
  if (key.length < 3) return null;
  for (const b of blocks) {
    const bk = looseKey(b.t).slice(0, 60);
    if (bk.startsWith(key) || (bk.length >= 12 && key.startsWith(bk))) return b;
  }
  return null;
}

export const packBlocks = (blocks) => JSON.stringify(blocks.map((b) => [b.h, b.t.length > KEEP_CHARS ? b.t.slice(0, KEEP_CHARS) : b.t]));
export const unpackBlocks = (text) => { try { return JSON.parse(text).map(([h, t]) => ({ h, t })); } catch { return []; } };
