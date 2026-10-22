/* The Redline page layers: comments, pen, decisions, changes and the PDF button, in one script.
   Loaded by the site with `window.__REDLINE = {slug, title, pdf, version}` set just before. Plain ES2017, no dependencies.
   Parts: shared helpers, comments, pen (ink), changes, decisions, Download PDF, pinning (keeps the corner controls on screen when the page is zoomed).
   MIT License. The pen part inlines perfect-freehand, also MIT (see THIRD_PARTY.md). */
(function () {
  'use strict';
  var CFG = window.__REDLINE || {};
  var pm = /^\/([a-z0-9]{24})(\/|$)/.exec(location.pathname);
  var SLUG = CFG.slug || (pm && pm[1]);
  if (!SLUG || window.__REDLINE_STARTED) return;
  window.__REDLINE_STARTED = true;

  var root = document.documentElement;
  var vv = window.visualViewport;
  // Everything the layers add to the page. Text and pen anchoring never look inside these.
  var UI_SEL = '.rl,.rl-ink-ui,.rl-ink-msg,.rl-ink-pal,.rl-ink-svg,.rl-dec';
  var shared = { drewAt: 0 }; // when the pen last drew, so the comment layer does not read a stroke's end as a tap

  /* ---------- shared helpers ---------- */
  function $(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function lsGet(k) { try { return window.localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) {} }
  // The name lives in localStorage and, as a fallback, in a cookie (some browsers clear one but not the other). There is no default name.
  var AUTHOR_KEY = 'redline.author', COOKIE_KEY = 'redline_author';
  function cookieGet() {
    try {
      var m = document.cookie.match(new RegExp('(?:^|;\\s*)' + COOKIE_KEY + '=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : '';
    } catch (e) { return ''; }
  }
  function cookieSet(v) {
    try {
      document.cookie = COOKIE_KEY + '=' + encodeURIComponent(v) + '; max-age=31536000; path=/; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : '');
    } catch (e) {}
  }
  function getAuthor() {
    var v = lsGet(AUTHOR_KEY) || cookieGet();
    if (v) { if (!lsGet(AUTHOR_KEY)) lsSet(AUTHOR_KEY, v); if (!cookieGet()) cookieSet(v); }
    return v;
  }
  function setAuthor(v) { lsSet(AUTHOR_KEY, v); cookieSet(v); }
  // This browser remembers that its reader has marked the page up (a comment, a pen mark or a decision), so a new version can show them what changed.
  function markedUp() { lsSet('redline.marked.' + SLUG, '1'); }
  function ago(iso) {
    var t = Date.parse(iso); if (isNaN(t)) return '';
    var s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  // JSON calls to /api/<slug><base>. Rejects with the server's plain error text.
  function mkApi(base) {
    var url = '/api/' + SLUG + base;
    return function (method, path, body) {
      var opts = { method: method, credentials: 'same-origin', headers: {} };
      if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
      return fetch(url + path, opts).then(function (res) {
        return res.text().then(function (t) {
          var data = null; try { data = t ? JSON.parse(t) : null; } catch (e) {}
          if (!res.ok) throw new Error((data && data.error) || ('Request failed (' + res.status + ')'));
          return data || {};
        });
      });
    };
  }
  function zoomed() { return !!vv && Math.abs(vv.scale - 1) > 0.01; }
  function narrow() { try { return window.matchMedia('(max-width:639px)').matches; } catch (e) { return false; } }
  function panelOpen() { return root.classList.contains('rl-panel-open'); }
  function panelWidth() { return Math.min(372, (zoomed() ? vv.width * vv.scale : window.innerWidth) - 24); }

  /* ---------- pinning: corner controls stay in the visible corner when the page is pinch-zoomed ---------- */
  // A pinch-zoomed page keeps fixed elements on the unzoomed page (off screen), and fixed positions and pointer positions stop agreeing.
  // So while zoomed, each control is placed in page coordinates (the visual viewport's pageLeft / pageTop, the frame strokes use) and
  // scaled by 1 / zoom; unzoomed it goes back to its fixed CSS place. Offsets are in screen pixels. The registered function returns
  // {side: right|left|center, x, edge: bottom|top, y, w?, h?, maxH?}.
  var pinned = [], pinReq = 0, lastKey = '', lastScale = 1, zoomHooks = [];
  function registerPin(el, opts) { pinned.push({ el: el, opts: opts }); schedulePin(); }
  function onZoomChange(fn) { zoomHooks.push(fn); }
  function pin(el, o) {
    var st = el.style;
    if (!zoomed()) {
      if (el.rlPinned) {
        st.position = st.left = st.top = st.right = st.bottom = st.width = st.height = st.maxHeight = st.transform = st.transformOrigin = '';
        el.rlPinned = false;
      }
      return;
    }
    if (!el.getClientRects().length) return; // closed or hidden: placed when it opens
    var s = 1 / vv.scale;
    st.position = 'absolute'; st.right = st.bottom = 'auto';
    st.width = o.w ? o.w.toFixed(1) + 'px' : 'max-content';
    st.height = o.h ? o.h.toFixed(1) + 'px' : '';
    st.maxHeight = o.maxH ? o.maxH.toFixed(1) + 'px' : '';
    st.transformOrigin = '0 0'; st.transform = 'scale(' + s.toFixed(4) + ')';
    st.left = '0px'; st.top = '0px';
    el.rlPinned = true;
    // Where the element's containing block starts, whatever the host page's own positioning is.
    var r0 = el.getBoundingClientRect(), ox = r0.left + window.scrollX, oy = r0.top + window.scrollY;
    var w = el.offsetWidth * s, h = el.offsetHeight * s;
    var x = o.side === 'left' ? vv.pageLeft + o.x * s : o.side === 'center' ? vv.pageLeft + (vv.width - w) / 2 : vv.pageLeft + vv.width - o.x * s - w;
    var y = o.edge === 'top' ? vv.pageTop + o.y * s : vv.pageTop + vv.height - o.y * s - h;
    st.left = (Math.round((x - ox) * 10) / 10) + 'px';
    st.top = (Math.round((y - oy) * 10) / 10) + 'px';
  }
  function vvKey() { return vv ? [vv.scale.toFixed(3), Math.round(vv.pageLeft), Math.round(vv.pageTop), Math.round(vv.width), Math.round(vv.height)].join() : ''; }
  function pinAll() {
    pinReq = 0;
    lastKey = vvKey();
    for (var i = 0; i < pinned.length; i++) pin(pinned[i].el, pinned[i].opts());
    if (vv && Math.abs(vv.scale - lastScale) > 0.01) { lastScale = vv.scale; for (var k = 0; k < zoomHooks.length; k++) zoomHooks[k](); }
  }
  function schedulePin() { if (!pinReq) pinReq = requestAnimationFrame(pinAll); }
  if (vv) { vv.addEventListener('resize', schedulePin); vv.addEventListener('scroll', schedulePin); }
  window.addEventListener('scroll', schedulePin, { passive: true });
  window.addEventListener('resize', schedulePin);
  document.addEventListener('touchend', schedulePin, { passive: true, capture: true });
  document.addEventListener('gestureend', schedulePin); // Safari's pinch gesture
  // Safari can report a zoom late: while zoomed, check a few times a second.
  setInterval(function () {
    if (vv && (zoomed() || pinned.some(function (p) { return p.el.rlPinned; })) && vvKey() !== lastKey) schedulePin();
  }, 250);

  /* ================================ comments ================================ */
  (function () {
  var LIM = { body: 4000, anchor: 1000, label: 60 };
  var CTX = 48;                                   // characters of context kept on each side of an anchor
  var SKIP = 'script,style,noscript,template,textarea,svg,' + UI_SEL;
  var SKIP_SVG = 'title,desc,style,script,' + UI_SEL;
  var SVGNS = 'http://www.w3.org/2000/svg';
  var api = mkApi('/comments');
  var S = { comments: [], stale: [], loaded: false, error: '', open: false, composer: null, cand: null, pin: null, preview: null, lastLoad: 0 };
  var M = { general: [], placed: [], lost: [], pins: [], fixed: [], done: [] };
  // open: needs work. fixed: marked fixed, waiting for the reader. done: the reader confirmed. (A site from before the three states only says resolved.)
  function st(c) { return c.status || (c.resolved ? 'done' : 'open'); }
  var reduced = false;
  try { reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}

  /* ---------- small helpers ---------- */
  function isPhone() { return window.innerWidth < 640; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function shorten(s, n) { return s.length > n ? s.slice(0, n - 1).replace(/\s+$/, '') + '…' : s; }
  function squash(s) { return (s || '').replace(/\s+/g, ' ').trim(); }
  var ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 2.5A1.5 1.5 0 0 1 3.5 1h9A1.5 1.5 0 0 1 14 2.5v7a1.5 1.5 0 0 1-1.5 1.5H7l-3.2 3v-3H3.5A1.5 1.5 0 0 1 2 9.5v-7z"/></svg>';
  var PIN_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0.8a4.7 4.7 0 0 0-4.7 4.7c0 3.3 4.7 9.7 4.7 9.7s4.7-6.4 4.7-9.7A4.7 4.7 0 0 0 8 0.8zm0 6.6a1.9 1.9 0 1 1 0-3.8 1.9 1.9 0 0 1 0 3.8z"/></svg>';
  function withIcon(btn, icon, label) { btn.innerHTML = icon; btn.appendChild(document.createTextNode(label)); }

  /* ---------- comment kinds ---------- */
  function kindOf(c) { return c.anchor_kind || (c.anchor_text ? 'text' : 'general'); }
  function dataOf(c) {
    var d = c.anchor_data;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { d = null; } }
    return d && typeof d === 'object' ? d : null;
  }

  /* ---------- text index: visible text of the page (or of one diagram) with whitespace collapsed ---------- */
  var dispCache = typeof WeakMap === 'function' ? new WeakMap() : null;
  function isInlineEl(e) {
    var d = dispCache && dispCache.get(e);
    if (d === undefined || d === null) { d = window.getComputedStyle(e).display; if (dispCache) dispCache.set(e, d); }
    return d === 'inline' || d === 'contents';
  }
  function blockOf(n) {
    var e = n.parentElement;
    while (e && e !== document.body && isInlineEl(e)) e = e.parentElement;
    return e;
  }
  // In a diagram every <text>, and every <tspan> that starts a new line (has x or y), is its own block.
  function svgBlock(n, svg) {
    var e = n.parentElement;
    while (e && e !== svg) {
      if (e.localName === 'text' || e.hasAttribute('x') || e.hasAttribute('y')) return e;
      e = e.parentElement;
    }
    return svg;
  }
  function isWs(c) { return c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 160; }

  function buildIndex(rootEl, inSvg) {
    rootEl = rootEl || document.body;
    var idx = { text: '', nodes: [], byNode: new Map(), svg: !!inSvg, root: rootEl };
    if (!rootEl) return idx;
    var w = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, null);
    var t = '', lastSpace = true, lastBlock = null, n;
    while ((n = w.nextNode())) {
      var p = n.parentElement;
      if (!p || p.closest(inSvg ? SKIP_SVG : SKIP)) continue;
      if (inSvg && !p.closest('text')) continue;
      var s = n.nodeValue, len = s.length, blk = inSvg ? svgBlock(n, rootEl) : blockOf(n);
      if (lastBlock !== null && blk !== lastBlock && !lastSpace) { t += ' '; lastSpace = true; }
      lastBlock = blk;
      var rel = new Int32Array(len + 1), start = t.length;
      for (var k = 0; k < len; k++) {
        rel[k] = t.length;
        if (isWs(s.charCodeAt(k))) { if (!lastSpace) { t += ' '; lastSpace = true; } }
        else { t += s.charAt(k); lastSpace = false; }
      }
      rel[len] = t.length;
      var ent = { node: n, start: start, end: t.length, rel: rel, len: len };
      idx.nodes.push(ent); idx.byNode.set(n, ent);
    }
    idx.text = t;
    return idx;
  }
  // character offset inside ent.node of the character that produced normalized index i
  function offsetOf(ent, i) {
    var r = ent.rel;
    for (var k = 0; k < ent.len; k++) if (r[k] === i && r[k + 1] === i + 1) return k;
    return -1;
  }
  // normalized index of a DOM boundary point (the index of the first character at or after it)
  function pointIndex(idx, node, off) {
    var ent = idx.byNode.get(node);
    if (ent) return ent.rel[Math.min(off, ent.len)];
    var r = document.createRange();
    try { r.setStart(node, off); } catch (e) { return -1; }
    r.collapse(true);
    for (var i = 0; i < idx.nodes.length; i++) {
      if (r.comparePoint(idx.nodes[i].node, 0) >= 0) return idx.nodes[i].start;
    }
    return idx.text.length;
  }

  /* ---------- anchors ---------- */
  var OPEN = '⟦', CLOSE = '⟧';
  function makeContext(text, s, e) {
    var strip = function (x) { return x.split(OPEN).join('').split(CLOSE).join(''); };
    return strip(text.slice(Math.max(0, s - CTX), s)) + OPEN + strip(text.slice(s, e)) + CLOSE + strip(text.slice(e, e + CTX));
  }
  function parseContext(c) {
    var a = c.indexOf(OPEN), b = c.lastIndexOf(CLOSE);
    if (a < 0 || b < a) return { pre: '', suf: '' };
    return { pre: c.slice(0, a), suf: c.slice(b + 1) };
  }
  function commonSuffix(a, b) { var i = 0; while (i < a.length && i < b.length && a.charAt(a.length - 1 - i) === b.charAt(b.length - 1 - i)) i++; return i; }
  function commonPrefix(a, b) { var i = 0; while (i < a.length && i < b.length && a.charAt(i) === b.charAt(i)) i++; return i; }

  function findAnchor(idx, anchor, context) {
    if (!anchor) return null;
    var tries = [anchor, squash(anchor)], hits = [], ti, a;
    for (ti = 0; ti < tries.length && !hits.length; ti++) {
      a = tries[ti]; if (!a) continue;
      var from = 0, i;
      while (hits.length < 400 && (i = idx.text.indexOf(a, from)) >= 0) { hits.push(i); from = i + 1; }
    }
    if (!hits.length) return null;
    var best = hits[0];
    if (hits.length > 1) {
      var cx = parseContext(context || ''), top = -1;
      for (var h = 0; h < hits.length; h++) {
        var at = hits[h];
        var sc = commonSuffix(idx.text.slice(Math.max(0, at - CTX), at), cx.pre) +
                 commonPrefix(idx.text.slice(at + a.length, at + a.length + CTX), cx.suf);
        if (sc > top) { top = sc; best = at; }
      }
    }
    return [best, best + a.length];
  }

  /* ---------- diagrams (inline SVG) and images ---------- */
  function outerSvg(node) {
    var el = node && (node.nodeType === 1 ? node : node.parentElement), out = null;
    while (el) {
      if (el.localName === 'svg' && !el.closest(UI_SEL)) out = el;
      el = el.parentElement;
    }
    return out;
  }
  function allSvgs() {
    return Array.prototype.filter.call(document.querySelectorAll('svg'), function (s) {
      return !s.closest(UI_SEL) && !(s.parentElement && s.parentElement.closest('svg'));
    });
  }
  function allImgs() {
    return Array.prototype.filter.call(document.querySelectorAll('img'), function (i) { return !i.closest(UI_SEL); });
  }
  function targetId(el, svgs, imgs) {
    if (el.localName === 'svg') return 'svg-' + ((svgs || allSvgs()).indexOf(el) + 1);
    return 'img-' + ((imgs || allImgs()).indexOf(el) + 1);
  }
  function targetById(id, alt, svgs, imgs) {
    var m = /^(svg|img)-(\d+)$/.exec(id || '');
    if (!m) return null;
    var list = m[1] === 'svg' ? (svgs || allSvgs()) : (imgs || allImgs());
    var el = list[+m[2] - 1] || null;
    if (m[1] === 'img' && alt && (!el || el.getAttribute('alt') !== alt)) {
      for (var i = 0; i < list.length; i++) if (list[i].getAttribute('alt') === alt) return list[i];
    }
    return el;
  }
  // "The home screen" from the figcaption "The home screen. Each floor has ..."
  function captionOf(svg) {
    var fig = svg.closest('figure'), cap = fig && fig.querySelector('figcaption');
    return cap ? shorten(squash(cap.textContent).split(/[.:—]/)[0].trim(), 60) : '';
  }
  function diagramLabel(svg, svgs) {
    var n = (svgs || allSvgs()).indexOf(svg) + 1, cap = captionOf(svg);
    return 'Diagram ' + n + (cap ? ': ' + cap : '');
  }
  // the text label in the diagram closest to a point (client coordinates)
  function nearestLabel(svg, cx, cy) {
    var cands = svg.querySelectorAll('text, tspan[x], tspan[y]'), best = '', bd = Infinity;
    for (var i = 0; i < cands.length; i++) {
      var t = cands[i];
      if (t.localName === 'text' && t.querySelector('tspan[x], tspan[y]')) continue;   // use its lines instead
      var txt = squash(t.textContent); if (!txt) continue;
      var r = t.getBoundingClientRect(); if (!r.width && !r.height) continue;
      var dx = cx < r.left ? r.left - cx : (cx > r.right ? cx - r.right : 0);
      var dy = cy < r.top ? r.top - cy : (cy > r.bottom ? cy - r.bottom : 0);
      var d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = txt; }
    }
    return bd <= 200 * 200 ? shorten(best, 60) : '';
  }
  function pinSpot(target, cx, cy) {
    var r = target.getBoundingClientRect(), isSvg = target.localName === 'svg';
    var svgs = allSvgs(), imgs = allImgs();
    var x = Math.round(clamp((cx - r.left) / (r.width || 1) * 100, 0, 100) * 10) / 10;
    var y = Math.round(clamp((cy - r.top) / (r.height || 1) * 100, 0, 100) * 10) / 10;
    var label = isSvg ? diagramLabel(target, svgs) : (squash(target.getAttribute('alt')) || ('Image ' + (imgs.indexOf(target) + 1)));
    var near = isSvg ? nearestLabel(target, cx, cy) : '';
    return {
      kind: 'pin', target: target, tid: targetId(target, svgs, imgs), x: x, y: y, near: near, label: label,
      alt: isSvg ? '' : squash(target.getAttribute('alt')),
      readable: isSvg ? label + (near ? ', near: ' + near : '') : label + ' (image)'
    };
  }

  /* ---------- highlights (HTML <mark>, or <tspan> inside a diagram) ---------- */
  function wrapRange(idx, s, e, cid, extra) {
    var made = [];
    for (var j = 0; j < idx.nodes.length; j++) {
      var ent = idx.nodes[j];
      if (ent.start >= e) break;
      if (ent.end <= s) continue;
      var ks = s <= ent.start ? 0 : offsetOf(ent, s);
      var ke = e >= ent.end ? ent.len : offsetOf(ent, e - 1) + 1;
      if (ks < 0 || ke <= ks) continue;
      var node = ent.node;
      if (!/\S/.test(node.nodeValue.slice(ks, ke))) continue;
      if (ke < node.nodeValue.length) node.splitText(ke);
      if (ks > 0) node = node.splitText(ks);
      var m;
      if (idx.svg) { m = document.createElementNS(SVGNS, 'tspan'); m.setAttribute('class', 'rl-hl' + (extra ? ' ' + extra : '')); }
      else m = $('mark', 'rl-hl' + (extra ? ' ' + extra : ''));
      m.setAttribute('data-cid', String(cid));
      node.parentNode.insertBefore(m, node);
      m.appendChild(node);
      made.push(m);
    }
    return made;
  }
  function marksOf(cid) { return document.querySelectorAll('.rl-hl[data-cid="' + cid + '"]'); }
  function unwrap(cid) {
    var ms = marksOf(cid);
    for (var i = 0; i < ms.length; i++) {
      var m = ms[i], p = m.parentNode;
      if (!p) continue;
      while (m.firstChild) p.insertBefore(m.firstChild, m);
      p.removeChild(m);
      p.normalize();
    }
  }
  function setClass(el, name, on) {
    var c = ' ' + (el.getAttribute('class') || '') + ' ';
    var has = c.indexOf(' ' + name + ' ') >= 0;
    if (on && !has) el.setAttribute('class', (c + name).trim());
    else if (!on && has) el.setAttribute('class', c.replace(' ' + name + ' ', ' ').trim());
  }

  // Put the highlight for one text or diagram-text comment into the page.
  function place(c) {
    if (st(c) !== 'open') return;
    var kind = kindOf(c), idx, f;
    if (kind === 'text') {
      idx = buildIndex();
      f = findAnchor(idx, c.anchor_text, c.anchor_context);
      if (f) wrapRange(idx, f[0], f[1], c.id, '');
    } else if (kind === 'svg') {
      var d = dataOf(c) || {}, svgs = allSvgs(), ranked = [];
      svgs.forEach(function (sv, i) {
        var score = 0;
        if (d.fig === 'svg-' + (i + 1)) score += 1;
        if (d.cap && captionOf(sv) === d.cap) score += 2;
        ranked.push({ sv: sv, score: score, i: i });
      });
      ranked.sort(function (a, b) { return b.score - a.score || a.i - b.i; });
      for (var r = 0; r < ranked.length; r++) {
        idx = buildIndex(ranked[r].sv, true);
        f = findAnchor(idx, c.anchor_text, c.anchor_context);
        if (f) { wrapRange(idx, f[0], f[1], c.id, ''); return; }
      }
    }
  }
  function highlightAll() {
    var seen = {}, ms = document.querySelectorAll('.rl-hl:not(.rl-pending)'), i;
    for (i = 0; i < ms.length; i++) seen[ms[i].getAttribute('data-cid')] = 1;
    for (var cid in seen) unwrap(cid);
    S.comments.forEach(function (c) { if (st(c) === 'open') place(c); });
  }

  /* ---------- page-order model: where every open comment is on the page ---------- */
  function docOrder(a, b) {
    if (a._node === b._node) return (a._pd && b._pd) ? ((a._pd.y - b._pd.y) || (a._pd.x - b._pd.x)) : (a.id - b.id);
    var rel = a._node.compareDocumentPosition(b._node);
    if (rel & 4) return -1;
    if (rel & 2) return 1;
    return 0;
  }
  function layout() {
    var open = S.comments.filter(function (c) { return st(c) === 'open'; });
    var svgs = allSvgs(), imgs = allImgs();
    open.forEach(function (c) {
      c._kind = kindOf(c); c._node = null; c._pd = null; c._pin = 0;
      if (c._kind === 'pin') {
        c._pd = dataOf(c);
        c._node = c._pd ? targetById(c._pd.t, c._pd.alt, svgs, imgs) : null;
      } else if (c._kind === 'text' || c._kind === 'svg') {
        var m = marksOf(c.id); c._node = m.length ? m[0] : null;
      }
    });
    var placed = open.filter(function (c) { return c._kind !== 'general' && c._node; }).sort(docOrder);
    var n = 0;
    placed.forEach(function (c) { if (c._kind === 'pin') c._pin = ++n; });
    M = {
      general: open.filter(function (c) { return c._kind === 'general'; }),
      placed: placed,
      lost: open.filter(function (c) { return c._kind !== 'general' && !c._node; }),
      pins: placed.filter(function (c) { return c._kind === 'pin'; }),
      fixed: S.comments.filter(function (c) { return st(c) === 'fixed'; }),
      done: S.comments.filter(function (c) { return st(c) === 'done'; })
    };
  }

  /* ---------- state + loading ---------- */
  function openCount() { return S.comments.filter(function (c) { return st(c) === 'open'; }).length; }
  function fixedCount() { return S.comments.filter(function (c) { return st(c) === 'fixed'; }).length; }

  // Pen marks drawn on a paragraph that has changed since (only asked for once the page has a second version).
  function loadStale() {
    if (!(CFG.version > 1)) return Promise.resolve();
    return mkApi('/ink')('GET', '').then(function (r) {
      S.stale = (r.ink || []).filter(function (m) { return m.stale && m.data; });
    }).catch(function () { /* an extra: the panel works without it */ });
  }

  function load(silent) {
    S.lastLoad = Date.now();
    return api('GET', '').then(function (data) {
      S.comments = (data && data.comments) || [];
      S.loaded = true; S.error = '';
      return loadStale().then(function () {
        if (!S.composer) highlightAll();
        render();
      });
    }).catch(function (err) {
      S.error = err.message || 'Could not load comments';
      if (!silent || !S.loaded) render();
    });
  }

  /* ---------- UI shell ---------- */
  var tab, panel, listBox, countEl, subEl, generalBox, selBtn, pinBtn, toastEl, toastTimer, pinEls = [], posQueued = false;

  function toast(msg) {
    if (!toastEl) {
      toastEl = $('div', 'rl rl-toast'); toastEl.setAttribute('role', 'status'); root.appendChild(toastEl);
      registerPin(toastEl, function () { return { side: 'center', edge: 'bottom', y: 22 }; });
    }
    toastEl.textContent = msg; toastEl.hidden = false;
    schedulePin();
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, 2200);
  }

  // The author label. Asked for on the first comment (pre-filled), then remembered (localStorage + cookie).
  var authorFields = [];
  function authorField() {
    var wrap = $('div', 'rl-who'), input = null, stored = getAuthor();
    function showName() {
      wrap.textContent = '';
      wrap.appendChild(document.createTextNode('as '));
      wrap.appendChild($('b', '', stored));
      var ch = $('button', 'rl-link', 'change'); ch.type = 'button';
      ch.onclick = function () { showInput(stored); input.focus(); input.select(); };
      wrap.appendChild(document.createTextNode(' '));
      wrap.appendChild(ch);
      input = null;
    }
    function showInput(value) {
      wrap.textContent = '';
      input = $('input'); input.type = 'text'; input.maxLength = LIM.label;
      input.placeholder = 'Your name'; input.setAttribute('aria-label', 'Your name');
      input.autocomplete = 'nickname'; input.value = value;
      wrap.appendChild(input);
    }
    if (stored) showName(); else showInput('');
    var field = {
      node: wrap,
      sync: function () { var v = getAuthor(); if (v && v !== stored) { stored = v; showName(); } },
      get: function () { return (input ? input.value : stored).trim().slice(0, LIM.label); },
      commit: function () {
        var v = field.get();
        if (v) { setAuthor(v); stored = v; showName(); authorFields.forEach(function (f) { f.sync(); }); }
      },
      focus: function () { if (input) input.focus(); }
    };
    authorFields.push(field);
    return field;
  }

  function buildShell() {
    tab = $('button', 'rl rl-tab'); tab.type = 'button';
    tab.innerHTML = ICON;
    tab.appendChild(document.createTextNode('Comments'));
    countEl = $('span', 'rl-count', '0'); countEl.setAttribute('data-n', '0');
    tab.appendChild(countEl);
    tab.setAttribute('aria-label', 'Open comments');
    tab.onclick = function () { setOpen(true); };

    panel = $('aside', 'rl rl-panel'); panel.setAttribute('aria-label', 'Comments');
    var head = $('div', 'rl-head'), h = $('h2', '', 'Comments');
    subEl = $('span', 'rl-sub', ''); h.appendChild(subEl);
    var close = $('button', 'rl-link', 'Close'); close.type = 'button'; close.onclick = function () { setOpen(false); };
    head.appendChild(h); head.appendChild(close);
    var scroll = $('div', 'rl-scroll');
    scroll.appendChild($('p', 'rl-hint', 'Select text to comment on it. Tap a diagram or a picture to drop a numbered pin.'));

    generalBox = $('div', 'rl-general');
    var lab = $('label', '', 'Note on the whole document');
    var ta = $('textarea'); ta.maxLength = LIM.body; ta.placeholder = 'Write a general note…';
    var id = 'rl-general-ta'; ta.id = id; lab.setAttribute('for', id);
    var who = authorField();
    var row = $('div', 'rl-row'), btns = $('div', 'rl-btns');
    var add = $('button', 'rl-primary', 'Add note'); add.type = 'button';
    var err = $('div', 'rl-err'); err.hidden = true;
    btns.appendChild(add); row.appendChild(who.node); row.appendChild(btns);
    generalBox.appendChild(lab); generalBox.appendChild(ta); generalBox.appendChild(row); generalBox.appendChild(err);
    function submitGeneral() {
      var body = ta.value.trim(), name = who.get();
      if (!body) { err.textContent = 'Write something first.'; err.hidden = false; return; }
      if (!name) { err.textContent = 'Please add your name.'; err.hidden = false; who.focus(); return; }
      add.disabled = true; err.hidden = true;
      api('POST', '', { anchor_kind: '', anchor_text: '', anchor_context: '', body: body, author_label: name }).then(function (r) {
        who.commit(); ta.value = '';
        S.comments.push(r.comment); markedUp(); render(); toast('Note saved');
      }).catch(function (e) { err.textContent = e.message; err.hidden = false; })
        .then(function () { add.disabled = false; });
    }
    add.onclick = submitGeneral;
    ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submitGeneral(); } });

    listBox = $('div', 'rl-list');
    scroll.appendChild(generalBox); scroll.appendChild(listBox);
    panel.appendChild(head); panel.appendChild(scroll);

    selBtn = $('button', 'rl rl-selbtn'); selBtn.type = 'button';
    withIcon(selBtn, ICON, 'Comment');
    selBtn.setAttribute('aria-label', 'Add a comment on the selected text');

    pinBtn = $('button', 'rl rl-selbtn rl-pinbtn'); pinBtn.type = 'button';
    withIcon(pinBtn, PIN_ICON, 'Comment here');
    pinBtn.setAttribute('aria-label', 'Drop a pin and comment here');

    root.appendChild(tab); root.appendChild(panel); root.appendChild(selBtn); root.appendChild(pinBtn);
    registerPin(tab, function () { var n = narrow(); return { side: 'right', x: n ? 12 : 16, edge: 'bottom', y: n ? 12 : 16 }; });
    registerPin(panel, function () {
      var w = vv.width * vv.scale;                       // the visible width in screen pixels
      if (narrow()) return { side: 'left', x: 0, edge: 'bottom', y: 0, w: w, maxH: vv.height * vv.scale * 0.68 };
      return { side: 'right', x: 12, edge: 'top', y: 12, w: Math.min(372, w - 24), h: vv.height * vv.scale - 24 };
    });
  }

  function setOpen(b) {
    S.open = b;
    panel.classList.toggle('is-open', b);
    root.classList.toggle('rl-panel-open', b);
    tab.hidden = b;
    if (b) render();
    schedulePin();
  }

  /* ---------- pins (numbered markers over a diagram or picture) ---------- */
  function pinEl(label, cls) {
    var el = $('button', 'rl rl-pin' + (cls ? ' ' + cls : ''), label);
    el.type = 'button';
    return el;
  }
  function placeAt(el, target, x, y) {
    var r = target && target.getBoundingClientRect();
    if (!r || !r.width || !r.height) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.style.left = (r.left + window.pageXOffset + x / 100 * r.width) + 'px';
    el.style.top = (r.top + window.pageYOffset + y / 100 * r.height) + 'px';
  }
  function positionPins() {
    posQueued = false;
    M.pins.forEach(function (c) { if (c._el && c._pd) placeAt(c._el, c._node, c._pd.x, c._pd.y); });
    if (S.preview) placeAt(S.preview.el, S.preview.target, S.preview.x, S.preview.y);
  }
  function queuePositions() {
    if (posQueued) return;
    posQueued = true;
    (window.requestAnimationFrame || window.setTimeout)(positionPins, 16);
  }
  function renderPins() {
    pinEls.forEach(function (el) { if (el.parentNode) el.parentNode.removeChild(el); });
    pinEls = [];
    M.pins.forEach(function (c) {
      var el = pinEl(String(c._pin));
      el.setAttribute('data-pin', c.id);
      el.setAttribute('aria-label', 'Pin ' + c._pin + ': ' + shorten(c.body, 80));
      el.onclick = function () { flashCard(c.id); };
      root.appendChild(el); c._el = el; pinEls.push(el);
    });
    positionPins();
  }
  function setPreview(spot, pending) {
    clearPreview();
    var el = pinEl('', 'is-preview' + (pending ? ' is-pending' : ''));
    el.tabIndex = -1; el.setAttribute('aria-hidden', 'true');
    root.appendChild(el);
    S.preview = { el: el, target: spot.target, x: spot.x, y: spot.y };
    positionPins();
  }
  function clearPreview() {
    if (S.preview && S.preview.el.parentNode) S.preview.el.parentNode.removeChild(S.preview.el);
    S.preview = null;
  }

  /* ---------- rendering the list ---------- */
  function card(c, located) {
    var kind = kindOf(c), d = dataOf(c), state = st(c);
    var el = $('div', 'rl-card' + (state === 'done' ? ' is-resolved' : '') + (state === 'fixed' ? ' is-fixed' : ''));
    el.setAttribute('data-card', c.id);
    var meta = $('div', 'rl-meta');
    if (kind === 'pin' && c._pin) meta.appendChild($('span', 'rl-badge', 'Pin ' + c._pin));
    meta.appendChild($('b', '', c.author_label || 'Anonymous'));
    meta.appendChild(document.createTextNode(' \u00b7 ' + ago(c.created_at) + (state === 'done' ? ' \u00b7 confirmed' : '')));
    el.appendChild(meta);
    var quote = kind === 'pin' ? (c.anchor_context || (d && d.label) || 'Pin') : c.anchor_text;
    var open = state === 'open';
    if (quote) {
      el.appendChild($('blockquote', 'rl-quote' + (kind === 'pin' ? ' is-pin' : '') + (open && !located ? ' is-missing' : ''), shorten(quote, 240)));
      if (kind === 'svg' && d && d.label) el.appendChild($('div', 'rl-meta', 'In ' + d.label));
      if (open && !located) el.appendChild($('div', 'rl-meta', 'This spot is not in the current version of the page.'));
    }
    el.appendChild($('p', 'rl-text', c.body));
    if (state === 'fixed' || (open && c.reopened)) {
      var fix = $('div', 'rl-fix' + (state === 'fixed' ? '' : ' is-back'));
      fix.appendChild($('b', '', state === 'fixed' ? 'Marked fixed' + (c.fixed_version ? ' in version ' + c.fixed_version : '') : 'Sent back after it was marked fixed'));
      if (c.fix_note) fix.appendChild($('p', 'rl-fixnote', c.fix_note));
      el.appendChild(fix);
    }
    var acts = $('div', 'rl-acts');
    function act(label, status, primary) {
      var b = $('button', primary ? 'rl-primary' : '', label); b.type = 'button';
      b.onclick = function () { b.disabled = true; setStatus(c, status).catch(function (e) { b.disabled = false; toast(e.message); }); };
      acts.appendChild(b);
    }
    if (state === 'fixed') {
      act('Looks good', 'done', true);
      act('Not fixed', 'open');
    } else if (state === 'done') {
      act('Reopen', 'open');
    } else {
      if (located) {
        var j = $('button', '', kind === 'pin' ? 'Jump to pin' : 'Jump to text'); j.type = 'button'; j.onclick = function () { jump(c.id); };
        acts.appendChild(j);
      }
      act('Resolve', 'done');
    }
    el.appendChild(acts);
    return el;
  }

  // Pen marks drawn on a paragraph that has changed since, grouped by paragraph.
  function staleBlock() {
    var groups = [], by = {};
    S.stale.forEach(function (m) {
      var key = (m.data.a && m.data.a.t) || '';
      if (!by[key]) { by[key] = { text: key, ids: [] }; groups.push(by[key]); }
      by[key].ids.push(m.id);
    });
    if (!groups.length) return null;
    var box = $('div', 'rl-stale');
    box.appendChild($('div', 'rl-sec', 'Pen marks on text that changed'));
    groups.forEach(function (g) {
      var el = $('div', 'rl-card is-changed');
      el.appendChild($('div', 'rl-meta', 'This paragraph changed after you drew on it.'));
      if (g.text) el.appendChild($('blockquote', 'rl-quote', shorten(g.text, 160)));
      el.appendChild($('div', 'rl-meta', g.ids.length + (g.ids.length === 1 ? ' mark' : ' marks')));
      var acts = $('div', 'rl-acts'), b = $('button', '', g.ids.length === 1 ? 'Erase this mark' : 'Erase these marks'); b.type = 'button';
      b.onclick = function () {
        b.disabled = true;
        var pen = mkApi('/ink');
        Promise.all(g.ids.map(function (id) { return pen('DELETE', '/' + id); })).then(function () {
          S.stale = S.stale.filter(function (m) { return g.ids.indexOf(m.id) < 0; });
          if (window.__REDLINE_INK && window.__REDLINE_INK.reload) window.__REDLINE_INK.reload();
          render();
        }).catch(function (e) { b.disabled = false; toast(e.message); });
      };
      acts.appendChild(b); el.appendChild(acts); box.appendChild(el);
    });
    return box;
  }

  function render() {
    if (!tab) return;
    layout();
    renderPins();
    var n = openCount(), w = fixedCount(), need = n + w;
    countEl.textContent = String(need); countEl.setAttribute('data-n', String(need));
    tab.setAttribute('aria-label', 'Open comments (' + n + ' open' + (w ? ', ' + w + ' marked fixed' : '') + ')');
    if (!S.open) return;
    subEl.textContent = need ? [n ? n + ' open' : '', w ? w + ' to check' : ''].filter(Boolean).join(', ') : '';
    listBox.textContent = '';
    if (S.error && !S.loaded) {
      listBox.appendChild($('p', 'rl-err', S.error));
      var rt = $('button', '', 'Try again'); rt.type = 'button'; rt.onclick = function () { load(); };
      listBox.appendChild(rt); return;
    }
    if (!S.loaded) { listBox.appendChild($('p', 'rl-empty', 'Loading…')); return; }

    if (!n && !w) listBox.appendChild($('p', 'rl-empty', 'No open comments yet.'));
    if (M.fixed.length) { listBox.appendChild($('div', 'rl-sec', 'Marked fixed: is it?')); M.fixed.forEach(function (c) { listBox.appendChild(card(c, false)); }); }
    if (M.general.length) { listBox.appendChild($('div', 'rl-sec', 'Whole document')); M.general.forEach(function (c) { listBox.appendChild(card(c, false)); }); }
    if (M.placed.length) { listBox.appendChild($('div', 'rl-sec', 'On the page, in order')); M.placed.forEach(function (c) { listBox.appendChild(card(c, true)); }); }
    if (M.lost.length) { listBox.appendChild($('div', 'rl-sec', 'No longer found on the page')); M.lost.forEach(function (c) { listBox.appendChild(card(c, false)); }); }
    var stale = staleBlock();
    if (stale) listBox.appendChild(stale);
    if (M.done.length) {
      var det = $('details', 'rl-resolved'), sum = $('summary', '', 'Confirmed (' + M.done.length + ')');
      det.appendChild(sum); M.done.forEach(function (c) { det.appendChild(card(c, false)); });
      listBox.appendChild(det);
    }
    if (S.error) listBox.appendChild($('p', 'rl-err', 'Could not refresh: ' + S.error));
  }

  function setStatus(c, status) {
    return api('POST', '/' + c.id + '/status', { status: status }).then(function (r) {
      Object.assign(c, r.comment);
      if (st(c) === 'open') place(c); else unwrap(c.id);
      markedUp();
      render();
    });
  }

  function flashCard(id) {
    if (!S.open) setOpen(true);
    var d = panel.querySelector('[data-card="' + id + '"]');
    if (!d) return;
    if (d.scrollIntoView) d.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
    d.classList.add('is-flash');
    setTimeout(function () { d.classList.remove('is-flash'); }, 1600);
  }
  function openDetailsAround(node) {
    for (var p = node && (node.nodeType === 1 ? node : node.parentElement); p; p = p.parentElement) {
      if (p.tagName === 'DETAILS' && !p.open) p.open = true;
    }
  }
  function jump(id) {
    var c = null, i;
    for (i = 0; i < S.comments.length; i++) if (String(S.comments[i].id) === String(id)) c = S.comments[i];
    if (!c) return;
    var pin = kindOf(c) === 'pin', ms = pin ? [] : Array.prototype.slice.call(marksOf(id));
    var anchor = pin ? c._node : ms[0];
    if (!anchor) return;
    openDetailsAround(anchor);
    if (isPhone()) setOpen(false);
    positionPins();
    var go = pin ? c._el : ms[0];
    if (go && go.scrollIntoView) go.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
    if (pin && c._el) { c._el.classList.add('is-flash'); setTimeout(function () { c._el.classList.remove('is-flash'); }, 1800); }
    ms.forEach(function (m) { setClass(m, 'rl-flash', true); });
    setTimeout(function () { ms.forEach(function (m) { setClass(m, 'rl-flash', false); }); }, 1800);
  }

  /* ---------- selection -> "Comment" button ---------- */
  var selTimer = null, hideTimer = null, btnHeld = false, heldTimer = null, pinTimer = null;

  function hideButton() { selBtn.style.display = 'none'; S.cand = null; }
  function scheduleHide() {
    if (btnHeld || hideTimer) return;
    hideTimer = setTimeout(function () { hideTimer = null; if (!btnHeld) hideButton(); }, 220);
  }
  function cancelHide() { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } }
  function isCoarse() { try { return window.matchMedia('(pointer: coarse)').matches; } catch (x) { return false; } }

  function placeFloating(btn, cx, cy, below) {
    btn.style.display = 'block';
    var w = btn.offsetWidth || 110;
    btn.style.left = clamp(cx + window.pageXOffset - w / 2, window.pageXOffset + 8, window.pageXOffset + root.clientWidth - w - 8) + 'px';
    btn.style.top = (cy + window.pageYOffset + below) + 'px';
  }

  function checkSelection() {
    if (S.composer) return;
    var sel = window.getSelection ? window.getSelection() : null;
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return scheduleHide();
    var r = sel.getRangeAt(0);
    var anc = r.commonAncestorContainer, ae = anc.nodeType === 1 ? anc : anc.parentElement;
    if (!ae || !document.body.contains(ae) || ae.closest(UI_SEL + ', textarea, input')) return scheduleHide();

    var svgA = outerSvg(r.startContainer), inSvg = !!svgA && svgA === outerSvg(r.endContainer);
    var idx = inSvg ? buildIndex(svgA, true) : buildIndex();
    var s = pointIndex(idx, r.startContainer, r.startOffset), e = pointIndex(idx, r.endContainer, r.endOffset);
    if (s < 0 || e < 0) return scheduleHide();
    if (e - s > LIM.anchor) e = s + LIM.anchor;
    while (s < e && idx.text.charCodeAt(s) === 32) s++;
    while (e > s && idx.text.charCodeAt(e - 1) === 32) e--;
    if (e - s < 2) return scheduleHide();

    var rects = r.getClientRects(), last = rects.length ? rects[rects.length - 1] : r.getBoundingClientRect();
    if (inSvg && !last.width && !last.height) { var sr = svgA.getBoundingClientRect(); last = { top: sr.bottom, bottom: sr.bottom, left: sr.left, right: sr.left + sr.width / 2 }; }
    cancelHide(); hidePinBtn();
    S.cand = {
      kind: inSvg ? 'svg' : 'text', svg: inSvg ? svgA : null, s: s, e: e, anchor: idx.text.slice(s, e), context: makeContext(idx.text, s, e),
      rect: { top: last.top, bottom: last.bottom, left: last.left, right: last.right }
    };
    if (inSvg) {
      var svgs = allSvgs();
      S.cand.fig = targetId(svgA, svgs); S.cand.cap = captionOf(svgA); S.cand.label = diagramLabel(svgA, svgs);
    }
    placeFloating(selBtn, last.right, last.bottom, isCoarse() ? 34 : 8);
  }
  function queueCheck(ms) { clearTimeout(selTimer); selTimer = setTimeout(checkSelection, ms); }

  function holdButton() { btnHeld = true; cancelHide(); clearTimeout(heldTimer); }
  function releaseButton() { clearTimeout(heldTimer); heldTimer = setTimeout(function () { btnHeld = false; }, 700); }

  /* ---------- "Comment here" (pin) button ---------- */
  function showPinBtn(spot, cx, cy) {
    hideButton(); hidePinBtn();
    S.pin = spot;
    setPreview(spot, false);
    placeFloating(pinBtn, cx, cy, isCoarse() ? 30 : 16);
    clearTimeout(pinTimer);
    pinTimer = setTimeout(hidePinBtn, 9000);
  }
  function hidePinBtn() {
    clearTimeout(pinTimer);
    if (pinBtn) pinBtn.style.display = 'none';
    if (S.pin) { S.pin = null; if (!S.composer) clearPreview(); }
  }

  /* ---------- composer (note on a selection or a pin) ---------- */
  function closeComposer(discard) {
    var c = S.composer;
    if (!c) return;
    S.composer = null;
    if (discard) unwrap('pending');
    clearPreview();
    if (c.node.parentNode) c.node.parentNode.removeChild(c.node);
    if (c.vv) { c.vv.removeEventListener('resize', c.onvv); c.vv.removeEventListener('scroll', c.onvv); }
  }

  function openComposer(cand) {
    closeComposer(true);
    var idx = null, s = 0, e = 0, marks = [], isPin = cand.kind === 'pin';
    if (isPin) {
      if (!cand.target || !cand.target.isConnected) { hidePinBtn(); return; }
      setPreview(cand, true);
    } else {
      var inSvg = cand.kind === 'svg';
      idx = inSvg ? buildIndex(cand.svg, true) : buildIndex();
      s = cand.s; e = cand.e;
      if (idx.text.slice(s, e) !== cand.anchor) {
        var f = findAnchor(idx, cand.anchor, cand.context);
        if (!f) { hideButton(); return; }
        s = f[0]; e = f[1];
      }
      marks = wrapRange(idx, s, e, 'pending', 'rl-pending');
    }
    hideButton(); hidePinBtn();
    try { var sel = window.getSelection(); if (sel) sel.removeAllRanges(); } catch (x) {}

    var box = $('div', 'rl rl-composer'); box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', 'Add a comment');
    if (isPin) {
      var ph = $('div', 'rl-pinhead'); ph.innerHTML = PIN_ICON; ph.appendChild(document.createTextNode(cand.readable));
      box.appendChild(ph);
    } else {
      if (cand.kind === 'svg') box.appendChild($('div', 'rl-meta', 'In ' + cand.label));
      box.appendChild($('blockquote', 'rl-quote', shorten(cand.anchor, 240)));
    }
    var ta = $('textarea'); ta.maxLength = LIM.body; ta.placeholder = isPin ? 'Your note on this spot…' : 'Your note on this text…'; ta.setAttribute('aria-label', 'Your note');
    box.appendChild(ta);
    var who = authorField();
    var row = $('div', 'rl-row'), btns = $('div', 'rl-btns');
    var cancel = $('button', '', 'Cancel'); cancel.type = 'button';
    var save = $('button', 'rl-primary', 'Save comment'); save.type = 'button';
    btns.appendChild(cancel); btns.appendChild(save);
    row.appendChild(who.node); row.appendChild(btns);
    box.appendChild(row);
    var err = $('div', 'rl-err'); err.hidden = true; box.appendChild(err);
    root.appendChild(box);

    var comp = { node: box, vv: window.visualViewport || null, onvv: null };
    S.composer = comp;

    function place() {
      if (isPhone() && !zoomed()) {
        box.style.position = ''; box.style.left = ''; box.style.top = ''; box.style.width = '';
        box.style.bottom = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) + 'px' : '0px';
        return;
      }
      var W = Math.min(390, (zoomed() ? vv.width : root.clientWidth) - 24), ref;
      box.style.position = 'absolute';
      if (isPin && S.preview) ref = S.preview.el.getBoundingClientRect();
      else ref = marks.length ? marks[marks.length - 1].getBoundingClientRect() : { left: cand.rect.left, bottom: cand.rect.bottom };
      box.style.bottom = 'auto'; box.style.width = W + 'px';
      box.style.left = clamp(ref.left + window.pageXOffset, window.pageXOffset + 12, window.pageXOffset + root.clientWidth - W - 12) + 'px';
      box.style.top = (ref.bottom + window.pageYOffset + 12) + 'px';
    }
    place();
    comp.onvv = place;
    if (comp.vv) { comp.vv.addEventListener('resize', comp.onvv); comp.vv.addEventListener('scroll', comp.onvv); }
    try { ta.focus({ preventScroll: true }); } catch (x) { ta.focus(); }
    if (box.scrollIntoView && !isPhone()) box.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });

    function submit() {
      var body = ta.value.trim(), name = who.get();
      if (!body) { err.textContent = 'Write something first.'; err.hidden = false; return; }
      if (!name) { err.textContent = 'Please add your name.'; err.hidden = false; who.focus(); return; }
      var payload = { body: body, author_label: name };
      if (isPin) {
        payload.anchor_kind = 'pin'; payload.anchor_text = ''; payload.anchor_context = cand.readable;
        payload.anchor_data = { t: cand.tid, x: cand.x, y: cand.y, near: cand.near, label: cand.label, alt: cand.alt };
      } else {
        payload.anchor_kind = cand.kind; payload.anchor_text = cand.anchor; payload.anchor_context = makeContext(idx.text, s, e);
        if (cand.kind === 'svg') payload.anchor_data = { fig: cand.fig, cap: cand.cap, label: cand.label };
      }
      save.disabled = true; err.hidden = true;
      api('POST', '', payload).then(function (r) {
        who.commit();
        var c = r.comment, ms = marksOf('pending');
        for (var i = 0; i < ms.length; i++) { ms[i].setAttribute('data-cid', String(c.id)); setClass(ms[i], 'rl-pending', false); }
        S.comments.push(c); markedUp();
        closeComposer(false);
        render(); toast(isPin ? 'Pin saved' : 'Comment saved');
      }).catch(function (x) { err.textContent = x.message; err.hidden = false; save.disabled = false; });
    }
    save.onclick = submit;
    cancel.onclick = function () { closeComposer(true); };
    box.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') { ev.stopPropagation(); closeComposer(true); }
      else if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); submit(); }
    });
  }

  /* ---------- wiring ---------- */
  var tapDown = null;

  function init() {
    buildShell();

    selBtn.addEventListener('mousedown', function (e) { e.preventDefault(); holdButton(); });   // keep the selection on desktop
    selBtn.addEventListener('touchstart', holdButton, { passive: true });
    selBtn.addEventListener('pointerdown', holdButton);
    selBtn.addEventListener('pointerup', releaseButton);
    selBtn.addEventListener('pointercancel', releaseButton);
    selBtn.addEventListener('touchend', releaseButton, { passive: true });
    selBtn.addEventListener('click', function () { var c = S.cand; if (c) openComposer(c); releaseButton(); });
    pinBtn.addEventListener('click', function () { var sp = S.pin; if (sp) { pinBtn.style.display = 'none'; clearTimeout(pinTimer); S.pin = null; openComposer(sp); } });

    document.addEventListener('selectionchange', function () { queueCheck(180); });
    document.addEventListener('mouseup', function () { queueCheck(10); });
    document.addEventListener('touchend', function () { queueCheck(350); }, { passive: true });
    document.addEventListener('keyup', function (e) { if (e.shiftKey || e.key === 'Shift') queueCheck(10); });
    window.addEventListener('resize', function () { if (S.cand) queueCheck(50); queuePositions(); });

    // Taps and clicks, detected with pointer events (iOS Safari does not deliver "click" to a document listener for plain elements).
    // A tap that does not drag, on a diagram or picture, offers "Comment here"; a tap on a highlight opens its comment.
    document.addEventListener('pointerdown', function (e) {
      tapDown = { x: e.clientX, y: e.clientY, t: Date.now(), id: e.pointerId };
      if (!(e.target && e.target.closest && e.target.closest('.rl-pinbtn'))) hidePinBtn();
    }, true);
    document.addEventListener('pointerup', function (e) {
      var d = tapDown; tapDown = null;
      if (!d || d.id !== e.pointerId || e.button > 0) return;
      if (Math.abs(e.clientX - d.x) > 8 || Math.abs(e.clientY - d.y) > 8) return;
      if (e.pointerType === 'touch' && Date.now() - d.t > 600) return;     // a long press is a text selection
      var t = e.target, cx = e.clientX, cy = e.clientY;
      if (!t || !t.closest || t.closest(UI_SEL)) return;
      setTimeout(function () {
        if (Date.now() - shared.drewAt < 700) return;                     // the end of a pen stroke, not a tap
        var sel = window.getSelection && window.getSelection();
        if (sel && !sel.isCollapsed) return;                              // the gesture was a selection
        var hl = t.closest('.rl-hl');
        if (hl) { if (!/rl-pending/.test(hl.getAttribute('class') || '')) flashCard(hl.getAttribute('data-cid')); return; }
        if (S.composer) return;
        if (t.closest('a, button, summary, input, select, textarea, label')) return;
        var tgt = t.closest('img') || outerSvg(t);
        if (!tgt || !tgt.isConnected) return;
        showPinBtn(pinSpot(tgt, cx, cy), cx, cy);
      }, 40);
    }, true);

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (S.pin) hidePinBtn();
      else if (S.open && !S.composer) setOpen(false);
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && !S.composer && Date.now() - S.lastLoad > 20000) load(true);
    });

    // keep pins glued to their diagram when the layout moves
    document.addEventListener('toggle', queuePositions, true);
    document.addEventListener('load', queuePositions, true);
    window.addEventListener('load', queuePositions);
    if (typeof ResizeObserver === 'function' && document.body) { try { new ResizeObserver(queuePositions).observe(document.body); } catch (e) {} }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(queuePositions);

    if (/(^|[#&])redline-comments\b/.test(window.location.hash)) setOpen(true);
    load();
  }


  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  })();

  /* ================================ pen ================================ */
  (function () {
  var api = mkApi('/ink');
  var SVGNS = 'http://www.w3.org/2000/svg';
  // A stroke is anchored to the block it starts on: these elements, outside the review tools.
  var BLOCKS = 'p,li,h1,h2,h3,h4,h5,h6,figure,table,pre,blockquote,dt,dd,img,svg,video,canvas';
  var TOOLS_SEL = UI_SEL;
  // With the toolbar closed, a Pencil still draws ("Pencil mode") except on these, which it taps as usual.
  var TAPS_SEL = 'a[href],button,input,select,textarea,label,summary,[role="button"],[contenteditable="true"],[contenteditable=""]';
  var COLORS = { red: '#d33a2c', blue: '#2358b8', black: '#1d2125', hl: 'rgba(255,200,0,.45)' };
  // Pens: line width in pixels at medium pressure, at the size the stroke was drawn (pressure makes it a little thinner or thicker).
  // Highlighter: a fixed width.
  var WIDTH = { red: 2.0, blue: 2.0, black: 1.9, hl: 16 };
  var HOLD_MS = 550; // a Pencil held still this long opens the pen palette at its tip
  var S = { items: [], on: false, tool: 'red', hidden: false, mine: [], draw: null, erasing: null, lastOurs: 0, sawPen: false, queue: [], blocks: null,
    pencil: true, hold: null };
  function store(k, v) { try { if (v == null) return window.localStorage.getItem(k); window.localStorage.setItem(k, v); } catch (e) {} return null; }
  S.pencil = store('redline.ink.pencil') !== '0';
  var SIZES = { s: 0.7, m: 1, l: 1.7 }; // the pen size setting, a multiple of the widths above
  S.size = SIZES[store('redline.ink.size')] ? store('redline.ink.size') : 'm';
  function penWidth(tool) { return WIDTH[tool] * SIZES[S.size]; }

  function $(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function squash(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

  /* ---------- the overlay ---------- */
  var svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', 'rl-ink-svg');
  svg.setAttribute('aria-hidden', 'true');
  document.body.appendChild(svg);
  var origin = { x: 0, y: 0 };
  function measureOrigin() {
    var r = svg.getBoundingClientRect();
    origin.x = r.left + window.scrollX; origin.y = r.top + window.scrollY;
  }

  /* ---------- anchors ---------- */
  function inTools(el) { return !!(el && el.closest && el.closest(TOOLS_SEL)); }
  function tappable(el) { return !!(el && el.closest && el.closest(TAPS_SEL)); }
  function blocks() {
    if (S.blocks) return S.blocks;
    var all = document.querySelectorAll(BLOCKS), out = [];
    for (var i = 0; i < all.length; i++) if (!inTools(all[i])) out.push(all[i]);
    S.fps = new Map(); S.pos = null; S.byKey = null; // caches below live as long as this list
    return (S.blocks = out);
  }
  // The text a block is recognised by, worked out once per pass (reading textContent of every block for every stroke froze big pages).
  function fp(el) {
    blocks();
    var v = S.fps.get(el);
    if (v === undefined) { v = squash((el.getAttribute && el.getAttribute('alt')) || el.textContent || '').slice(0, 80); S.fps.set(el, v); }
    return v;
  }
  function indexOfBlock(el) {
    var list = blocks();
    if (!S.pos) { S.pos = new Map(); for (var i = 0; i < list.length; i++) S.pos.set(list[i], i); }
    var n = S.pos.get(el);
    return n === undefined ? -1 : n;
  }
  // Blocks grouped by tag and fingerprint, so finding a stroke's block does not scan every block.
  function blocksByKey() {
    if (S.byKey) return S.byKey;
    var list = blocks(), map = S.byKey = Object.create(null);
    for (var i = 0; i < list.length; i++) {
      var key = list[i].tagName.toLowerCase() + '|' + fp(list[i]);
      (map[key] || (map[key] = [])).push(i);
    }
    return map;
  }
  function anchorAt(cx, cy) {
    var t = document.elementFromPoint(cx, cy), el = null;
    if (t && !inTools(t) && t.closest) el = t.closest(BLOCKS);
    if (el && inTools(el)) el = null;
    if (!el) { // margin or gap: the nearest block, by vertical distance first
      var list = blocks(), best = Infinity;
      for (var i = 0; i < list.length; i++) {
        var r = list[i].getBoundingClientRect();
        if (!r.width || !r.height) continue;
        var dy = cy < r.top ? r.top - cy : cy > r.bottom ? cy - r.bottom : 0;
        var dx = cx < r.left ? r.left - cx : cx > r.right ? cx - r.right : 0;
        var d = dy * 4 + dx;
        if (d < best) { best = d; el = list[i]; }
      }
    }
    if (!el) return null;
    return { el: el, a: { k: el.tagName.toLowerCase(), t: fp(el), i: Math.max(0, indexOfBlock(el)) } };
  }
  function resolve(a) {
    var list = blocks(), best = null, bd = Infinity, same = blocksByKey()[a.k + '|' + a.t] || [];
    for (var j = 0; j < same.length; j++) {
      var d = Math.abs(same[j] - a.i);
      if (d < bd) { bd = d; best = list[same[j]]; }
    }
    if (!best && list[a.i] && list[a.i].tagName.toLowerCase() === a.k) best = list[a.i];
    return best;
  }

  /* ---------- drawing strokes ---------- */
  // perfect-freehand 1.2.2 (MIT License, Copyright (c) 2021 Stephen Ruiz Ltd, github.com/steveruizok/perfect-freehand), inlined unchanged from
  // dist/esm/index.mjs: turns pen points with pressure into the outline of a stroke whose width follows the pressure, the way tldraw and
  // Excalidraw draw handwriting.
  var getStroke = (function () {
    function $(e,t,u,x=h=>h){return e*x(.5-t*(.5-u))}function se(e){return[-e[0],-e[1]]}function l(e,t){return[e[0]+t[0],e[1]+t[1]]}function a(e,t){return[e[0]-t[0],e[1]-t[1]]}function b(e,t){return[e[0]*t,e[1]*t]}function he(e,t){return[e[0]/t,e[1]/t]}function R(e){return[e[1],-e[0]]}function B(e,t){return e[0]*t[0]+e[1]*t[1]}function ue(e,t){return e[0]===t[0]&&e[1]===t[1]}function ge(e){return Math.hypot(e[0],e[1])}function de(e){return e[0]*e[0]+e[1]*e[1]}function A(e,t){return de(a(e,t))}function G(e){return he(e,ge(e))}function ie(e,t){return Math.hypot(e[1]-t[1],e[0]-t[0])}function L(e,t,u){let x=Math.sin(u),h=Math.cos(u),y=e[0]-t[0],n=e[1]-t[1],f=y*h-n*x,d=y*x+n*h;return[f+t[0],d+t[1]]}function K(e,t,u){return l(e,b(a(t,e),u))}function ee(e,t,u){return l(e,b(t,u))}var{min:C,PI:xe}=Math,pe=.275,V=xe+1e-4;function ce(e,t={}){let{size:u=16,smoothing:x=.5,thinning:h=.5,simulatePressure:y=!0,easing:n=r=>r,start:f={},end:d={},last:D=!1}=t,{cap:S=!0,easing:j=r=>r*(2-r)}=f,{cap:q=!0,easing:c=r=>--r*r*r+1}=d;if(e.length===0||u<=0)return[];let p=e[e.length-1].runningLength,g=f.taper===!1?0:f.taper===!0?Math.max(u,p):f.taper,T=d.taper===!1?0:d.taper===!0?Math.max(u,p):d.taper,te=Math.pow(u*x,2),_=[],M=[],H=e.slice(0,10).reduce((r,i)=>{let o=i.pressure;if(y){let s=C(1,i.distance/u),W=C(1,1-s);o=C(1,r+(W-r)*(s*pe))}return(r+o)/2},e[0].pressure),m=$(u,h,e[e.length-1].pressure,n),U,X=e[0].vector,z=e[0].point,F=z,O=z,E=F,J=!1;for(let r=0;r<e.length;r++){let{pressure:i}=e[r],{point:o,vector:s,distance:W,runningLength:I}=e[r];if(r<e.length-1&&p-I<3)continue;if(h){if(y){let v=C(1,W/u),Z=C(1,1-v);i=C(1,H+(Z-H)*(v*pe))}m=$(u,h,i,n)}else m=u/2;U===void 0&&(U=m);let le=I<g?j(I/g):1,fe=p-I<T?c((p-I)/T):1;m=Math.max(.01,m*Math.min(le,fe));let re=(r<e.length-1?e[r+1]:e[r]).vector,Y=r<e.length-1?B(s,re):1,be=B(s,X)<0&&!J,ne=Y!==null&&Y<0;if(be||ne){let v=b(R(X),m);for(let Z=1/13,w=0;w<=1;w+=Z)O=L(a(o,v),o,V*w),_.push(O),E=L(l(o,v),o,V*-w),M.push(E);z=O,F=E,ne&&(J=!0);continue}if(J=!1,r===e.length-1){let v=b(R(s),m);_.push(a(o,v)),M.push(l(o,v));continue}let oe=b(R(K(re,s,Y)),m);O=a(o,oe),(r<=1||A(z,O)>te)&&(_.push(O),z=O),E=l(o,oe),(r<=1||A(F,E)>te)&&(M.push(E),F=E),H=i,X=s}let P=e[0].point.slice(0,2),k=e.length>1?e[e.length-1].point.slice(0,2):l(e[0].point,[1,1]),Q=[],N=[];if(e.length===1){if(!(g||T)||D){let r=ee(P,G(R(a(P,k))),-(U||m)),i=[];for(let o=1/13,s=o;s<=1;s+=o)i.push(L(r,P,V*2*s));return i}}else{if(!(g||T&&e.length===1))if(S)for(let i=1/13,o=i;o<=1;o+=i){let s=L(M[0],P,V*o);Q.push(s)}else{let i=a(_[0],M[0]),o=b(i,.5),s=b(i,.51);Q.push(a(P,o),a(P,s),l(P,s),l(P,o))}let r=R(se(e[e.length-1].vector));if(T||g&&e.length===1)N.push(k);else if(q){let i=ee(k,r,m);for(let o=1/29,s=o;s<1;s+=o)N.push(L(i,k,V*3*s))}else N.push(l(k,b(r,m)),l(k,b(r,m*.99)),a(k,b(r,m*.99)),a(k,b(r,m)))}return _.concat(N,M.reverse(),Q)}function me(e,t={}){var q;let{streamline:u=.5,size:x=16,last:h=!1}=t;if(e.length===0)return[];let y=.15+(1-u)*.85,n=Array.isArray(e[0])?e:e.map(({x:c,y:p,pressure:g=.5})=>[c,p,g]);if(n.length===2){let c=n[1];n=n.slice(0,-1);for(let p=1;p<5;p++)n.push(K(n[0],c,p/4))}n.length===1&&(n=[...n,[...l(n[0],[1,1]),...n[0].slice(2)]]);let f=[{point:[n[0][0],n[0][1]],pressure:n[0][2]>=0?n[0][2]:.25,vector:[1,1],distance:0,runningLength:0}],d=!1,D=0,S=f[0],j=n.length-1;for(let c=1;c<n.length;c++){let p=h&&c===j?n[c].slice(0,2):K(S.point,n[c],y);if(ue(S.point,p))continue;let g=ie(p,S.point);if(D+=g,c<j&&!d){if(D<x)continue;d=!0}S={point:p,pressure:n[c][2]>=0?n[c][2]:.5,vector:G(a(S.point,p)),distance:g,runningLength:D},f.push(S)}return f[0].vector=((q=f[1])==null?void 0:q.vector)||[0,0],f}function ae(e,t={}){return ce(me(e,t),t)}
    return ae;
  })();
  // A steady gel-pen line with only a hint of pressure. Safari's Pencil pressure is low and noisy for ordinary writing (10 of 100 typical,
  // 18 firm, on a real iPad, 2026-10-22); letting it drive the width (v2.0-2.2: thinning 0.5 on a stretched pressure) made letters lumpy
  // and filled small loops ("blotting"). Safari reports Pencil positions in half pixels, so streamline evens out that step; at 240
  // samples a second it costs about 3 ms of lag. A mouse has no pressure, so its pressure is made up from speed.
  var PEN = { thinning: 0.15, smoothing: 0.5, streamline: 0.5, start: { cap: true, taper: 0 }, end: { cap: true, taper: 0 } };
  function f(n) { return Math.round(n * 10) / 10; }
  function f2(n) { return Math.round(n * 100) / 100; }
  // The outline of a pen stroke, as a closed SVG path (curves through the midpoints of the outline points).
  function outlineD(pts, size, simulate, last) {
    var o = getStroke(pts, { size: size, thinning: PEN.thinning, smoothing: PEN.smoothing, streamline: PEN.streamline, simulatePressure: simulate,
      last: last, start: PEN.start, end: PEN.end });
    if (o.length < 2) return '';
    var d = 'M' + f2(o[0][0]) + ' ' + f2(o[0][1]) + 'Q';
    for (var i = 0; i < o.length; i++) {
      var a = o[i], b = o[(i + 1) % o.length];
      d += f2(a[0]) + ' ' + f2(a[1]) + ' ' + f2((a[0] + b[0]) / 2) + ' ' + f2((a[1] + b[1]) / 2) + ' ';
    }
    return d + 'Z';
  }
  function pathD(pts) {
    if (!pts.length) return '';
    var d = 'M' + f(pts[0][0]) + ' ' + f(pts[0][1]);
    if (pts.length === 1) return d + 'l0.01 0';
    for (var i = 1; i < pts.length - 1; i++) {
      d += 'Q' + f(pts[i][0]) + ' ' + f(pts[i][1]) + ' ' + f((pts[i][0] + pts[i + 1][0]) / 2) + ' ' + f((pts[i][1] + pts[i + 1][1]) / 2);
    }
    var l = pts[pts.length - 1];
    return d + 'L' + f(l[0]) + ' ' + f(l[1]);
  }
  function makePath(color) {
    var p = document.createElementNS(SVGNS, 'path');
    if (color === 'hl') { p.setAttribute('class', 'rl-ink-hl'); p.setAttribute('stroke', COLORS.hl); }
    else { p.setAttribute('class', 'rl-ink-pen'); p.style.fill = COLORS[color] || COLORS.red; }
    svg.appendChild(p);
    return p;
  }
  // Highlighter: one fixed-width line. Pens: a filled outline whose width follows the pressure.
  function shape(path, color, pts, size, simulate, last) {
    if (color === 'hl') { path.setAttribute('d', pathD(pts)); path.setAttribute('stroke-width', f(size)); }
    else path.setAttribute('d', outlineD(pts, size, simulate, last));
  }
  // Places every saved stroke on the page as it is laid out now.
  function layout() {
    S.blocks = null;
    measureOrigin();
    // Read every block's box first, then draw: drawing a stroke dirties layout, so mixing the two made each stroke force a new layout.
    var rects = new Map(), i, el;
    for (i = 0; i < S.items.length; i++) {
      var a = S.items[i].data && S.items[i].data.a;
      el = a && S.items[i].data.p ? resolve(a) : null;
      if (el && !rects.has(el)) rects.set(el, el.getBoundingClientRect());
    }
    for (i = 0; i < S.items.length; i++) place(S.items[i], rects);
    updateCount();
  }
  function place(it, rects) {
    var d = it.data;
    if (!d || !d.a || !d.p) return;
    if (!it.path) it.path = makePath(d.c);
    var el = resolve(d.a);
    if (!el) { it.path.style.display = 'none'; it.pts = null; return; }
    var r = (rects && rects.get(el)) || el.getBoundingClientRect(), W = r.width || 1;
    var bx = r.left + window.scrollX - origin.x, by = r.top + window.scrollY - origin.y;
    var pts = [];
    for (var j = 0; j + 2 < d.p.length; j += 3) pts.push([bx + d.p[j] / 10000 * W, by + d.p[j + 1] / 10000 * W, d.p[j + 2] / 100]);
    it.pts = pts;
    it.path.style.display = '';
    shape(it.path, d.c, pts, d.w / 10000 * W, !!(d.m && d.m.ty === 'mouse'), true);
  }
  var layoutTimer = 0;
  function relayout() { clearTimeout(layoutTimer); layoutTimer = setTimeout(layout, 120); }

  /* ---------- input ---------- */
  function pagePoint(e) {
    var pr = e.pressure;
    if (e.pointerType === 'mouse' || !pr) pr = 0.5;
    return [e.clientX + window.scrollX - origin.x, e.clientY + window.scrollY - origin.y, Math.max(0, Math.min(1, pr))];
  }
  // Draw mode: a pen or mouse draws anywhere outside the review tools. Pencil mode: with the toolbar closed, a Pencil still draws, except on
  // links, buttons and fields, which it taps as usual. Fingers never draw.
  function pencilDraws(el) { return !inTools(el) && (S.on || (S.pencil && !S.hidden && !tappable(el))); }
  function draws(e) {
    if (e.pointerType === 'touch' || !pencilDraws(e.target)) return false;
    return S.on ? e.button === 0 || e.button === -1 || e.pointerType === 'pen' : e.pointerType === 'pen';
  }
  var MAX_PTS = 3900; // the server takes up to 4000 points per stroke
  function onDown(e) {
    if (pal && !inTools(e.target)) closePalette();
    if (!draws(e)) return;
    if (e.pointerType === 'pen') S.sawPen = true;
    e.preventDefault(); e.stopPropagation();
    S.lastOurs = shared.drewAt = Date.now();
    hideHover();
    measureOrigin();
    if (e.pointerType === 'pen') startHold(e);
    if (S.tool === 'erase') { S.erasing = e.pointerId; eraseAt(e); return; }
    // st: how the browser delivered this stroke (samples per second, samples per event, pressure range, whether it was cut short),
    // saved with it so real Pencil input can be checked later.
    S.draw = { id: e.pointerId, color: S.tool, width: penWidth(S.tool), cx: e.clientX, cy: e.clientY, pts: [pagePoint(e)], pred: [], path: makePath(S.tool),
      sim: e.pointerType !== 'pen', ty: e.pointerType, pencilMode: !S.on,
      st: { n: 1, ev: 0, t0: e.timeStamp, t1: e.timeStamp, fr: 0, p0: 1, p1: 0, cx: 0 } };
    track(S.draw, e);
    paint();
    try { document.documentElement.setPointerCapture(e.pointerId); } catch (err) {}
    if (!S.on && !store('redline.ink.tip')) {
      store('redline.ink.tip', '1');
      msg('Your Pencil now draws on this page, and your finger scrolls. Hold the Pencil still to change pens. Turn this off under Draw.', 7000);
    }
  }
  function track(D, ev) {
    var p = ev.pressure;
    if (D.ty === 'pen' && p > 0) { if (p < D.st.p0) D.st.p0 = p; if (p > D.st.p1) D.st.p1 = p; }
    if (ev.clientX % 1 || ev.clientY % 1) D.st.fr = 1;
  }
  function onMove(e) {
    if (e.pointerType === 'pen' && !e.buttons) { hover(e); return; }
    moveHold(e);
    if (S.erasing === e.pointerId) { e.preventDefault(); eraseAt(e); return; }
    var D = S.draw;
    if (!D || e.pointerId !== D.id) return;
    e.preventDefault();
    // Every sample the Pencil sent since the last event (up to 240 a second), not just the one per screen refresh.
    var evs = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
    if (!evs || !evs.length) evs = [e];
    D.st.ev++;
    // Samples closer than about one screen pixel are merged (keeping the higher pressure), as tldraw does: Safari's half-pixel
    // positions would otherwise put a jag in every slow curve.
    var near = 0.9 / (window.visualViewport ? window.visualViewport.scale || 1 : 1);
    for (var i = 0; i < evs.length; i++) {
      var p = pagePoint(evs[i]), l = D.pts[D.pts.length - 1];
      D.st.n++;
      track(D, evs[i]);
      if (Math.abs(p[0] - l[0]) + Math.abs(p[1] - l[1]) < near) { l[2] = Math.max(l[2], p[2]); continue; }
      if (D.pts.length < MAX_PTS) D.pts.push(p);
    }
    D.st.t1 = e.timeStamp;
    // Where the browser expects the tip to be next: drawn ahead of the real points so the ink keeps up with the Pencil, never saved.
    var pr = e.getPredictedEvents ? e.getPredictedEvents() : null;
    D.pred = [];
    if (pr) for (var k = 0; k < pr.length && k < 4; k++) D.pred.push(pagePoint(pr[k]));
    schedule();
  }
  function onUp(e) {
    endHold(e);
    if (S.erasing === e.pointerId) { S.erasing = null; S.lastOurs = Date.now(); return; }
    var D = S.draw;
    if (!D || e.pointerId !== D.id) return;
    S.draw = null;
    S.lastOurs = Date.now();
    if (e.type === 'pointercancel') {
      D.st.cx = 1;
      if (D.pts.length < 3) { svg.removeChild(D.path); return; }
    }
    D.pred = [];
    finish(D);
  }
  // The stroke being drawn is redrawn once per screen refresh, not once per event.
  var frameReq = 0;
  function schedule() { if (!frameReq) frameReq = requestAnimationFrame(paint); }
  function paint() {
    frameReq = 0;
    var D = S.draw;
    if (!D) return;
    shape(D.path, D.color, D.pred.length ? D.pts.concat(D.pred) : D.pts, D.width, D.sim, false);
  }

  /* ---------- holding the Pencil still opens the pen palette at its tip (web pages never see the Pencil Pro squeeze) ---------- */
  function startHold(e) {
    endHold();
    S.hold = { id: e.pointerId, x: e.clientX, y: e.clientY, timer: setTimeout(holdFired, HOLD_MS) };
  }
  function moveHold(e) {
    var H = S.hold;
    if (H && e.pointerId === H.id && Math.abs(e.clientX - H.x) + Math.abs(e.clientY - H.y) > 6) endHold();
  }
  function endHold(e) {
    var H = S.hold;
    if (!H || (e && e.pointerId !== H.id)) return;
    clearTimeout(H.timer);
    S.hold = null;
  }
  function holdFired() {
    var H = S.hold;
    S.hold = null;
    if (!H) return;
    var D = S.draw;
    if (D && D.id === H.id) { S.draw = null; if (D.path.parentNode) D.path.parentNode.removeChild(D.path); }
    if (S.erasing === H.id) S.erasing = null;
    try { document.documentElement.releasePointerCapture(H.id); } catch (err) {}
    S.lastOurs = Date.now();
    openPalette(H.x, H.y);
  }
  var pal = null;
  function openPalette(x, y) {
    closePalette();
    hideHover();
    pal = $('div', 'rl-ink-pal');
    pal.setAttribute('role', 'toolbar');
    pal.setAttribute('aria-label', 'Pens');
    ['red', 'blue', 'black', 'hl', 'erase'].forEach(function (k) {
      var b = btn(k === 'erase' ? 'Erase' : dot(k), toolBtns[k].title, function () { setTool(k); closePalette(); });
      b.setAttribute('aria-pressed', String(k === S.tool));
      pal.appendChild(b);
    });
    ['s', 'm', 'l'].forEach(function (k) {
      var b = btn(sizeDot(k), sizeBtns[k].title, function () { setSize(k); closePalette(); });
      b.setAttribute('aria-pressed', String(k === S.size));
      pal.appendChild(b);
    });
    pal.appendChild(btn('Undo', 'Undo your last mark', function () { undo(); closePalette(); }));
    document.body.appendChild(pal);
    // Placed above the tip (below it near the top edge), inside the visible area, at its normal size when the page is zoomed. Page
    // coordinates (as for strokes), because a zoomed Safari page puts fixed elements and pointer positions in different frames.
    measureOrigin();
    var s = vv ? 1 / vv.scale : 1, w = pal.offsetWidth * s, h = pal.offsetHeight * s;
    var px = x + window.scrollX, py = y + window.scrollY;
    var x0 = vv ? vv.pageLeft : window.scrollX, y0 = vv ? vv.pageTop : window.scrollY;
    var x1 = x0 + (vv ? vv.width : window.innerWidth), y1 = y0 + (vv ? vv.height : window.innerHeight);
    pal.style.transformOrigin = '0 0';
    pal.style.transform = s === 1 ? '' : 'scale(' + s.toFixed(4) + ')';
    pal.style.left = f(Math.max(x0 + 8 * s, Math.min(x1 - w - 8 * s, px - w / 2)) - origin.x) + 'px';
    pal.style.top = f((py - h - 28 * s < y0 + 8 * s ? Math.min(y1 - h - 8 * s, py + 28 * s) : py - h - 28 * s) - origin.y) + 'px';
  }
  function closePalette() { if (pal && pal.parentNode) pal.parentNode.removeChild(pal); pal = null; }

  /* ---------- Pencil hover (Apple Pencil Pro, or 2nd generation on newer iPads): a dot where the mark will land, and its paragraph ---------- */
  var hov = $('div', 'rl-ink-hover'), tgt = $('div', 'rl-ink-target'), hovAt = null, hovReq = 0, hovTimer = 0;
  document.body.appendChild(tgt);
  document.body.appendChild(hov);
  function hover(e) {
    if (S.draw || S.erasing != null || pal || !pencilDraws(e.target)) { hideHover(); return; }
    hovAt = { x: e.clientX, y: e.clientY, px: e.clientX + window.scrollX, py: e.clientY + window.scrollY };
    if (!hovReq) hovReq = requestAnimationFrame(paintHover);
    clearTimeout(hovTimer);
    hovTimer = setTimeout(hideHover, 1500);
  }
  function paintHover() {
    hovReq = 0;
    if (!hovAt) return;
    measureOrigin();
    var t = S.tool, size = t === 'erase' ? 28 : t === 'hl' ? penWidth('hl') : penWidth(t) + 3;
    hov.style.width = hov.style.height = size + 'px';
    hov.style.background = t === 'erase' ? 'rgba(255,255,255,.35)' : COLORS[t];
    hov.style.border = t === 'erase' ? '1.5px solid rgba(60,60,60,.7)' : '0';
    hov.style.transform = 'translate(' + f(hovAt.px - origin.x - size / 2) + 'px,' + f(hovAt.py - origin.y - size / 2) + 'px)';
    hov.style.display = 'block';
    var hit = t === 'erase' ? null : anchorAt(hovAt.x, hovAt.y);
    if (!hit) { tgt.style.display = 'none'; return; }
    var r = hit.el.getBoundingClientRect();
    tgt.style.left = f(r.left + window.scrollX - origin.x) + 'px'; tgt.style.top = f(r.top + window.scrollY - origin.y) + 'px';
    tgt.style.width = f(r.width) + 'px'; tgt.style.height = f(r.height) + 'px';
    tgt.style.display = 'block';
  }
  function hideHover() { hovAt = null; clearTimeout(hovTimer); hov.style.display = 'none'; tgt.style.display = 'none'; }
  document.addEventListener('pointerout', function (e) { if (e.pointerType === 'pen' && !e.relatedTarget) hideHover(); }, true);
  function finish(D) {
    S.blocks = null;
    var hit = anchorAt(D.cx, D.cy);
    if (!hit) { svg.removeChild(D.path); return; }
    var r = hit.el.getBoundingClientRect(), W = r.width || 1;
    var bx = r.left + window.scrollX - origin.x, by = r.top + window.scrollY - origin.y;
    var flat = [];
    for (var i = 0; i < D.pts.length; i++) {
      flat.push(Math.round((D.pts[i][0] - bx) / W * 10000), Math.round((D.pts[i][1] - by) / W * 10000), Math.round(D.pts[i][2] * 100));
    }
    var st = D.st, secs = (st.t1 - st.t0) / 1000;
    var m = { ty: /^(pen|mouse|touch)$/.test(D.ty) ? D.ty : '', hz: secs > 0.05 ? Math.round(st.n / secs) : 0, co: st.ev ? Math.round(st.n / st.ev * 10) / 10 : 0,
      fr: st.fr, p0: st.p1 ? Math.round(st.p0 * 100) : 0, p1: Math.round(st.p1 * 100), cx: st.cx, pm: D.pencilMode ? 1 : 0 };
    var data = { a: hit.a, c: D.color, w: Math.max(1, Math.round(D.width / W * 10000)), p: flat, tx: textUnder(D.pts), vw: window.innerWidth, m: m };
    var it = { id: null, data: data, path: D.path, pts: null, author_label: getAuthor(), created_at: new Date().toISOString() };
    S.items.push(it);
    place(it);
    updateCount();
    save(it);
  }
  // The words a stroke covers or sits next to (for reading marks back as text): the document range between the first and last
  // caret positions found along the stroke.
  function caretAt(x, y) {
    try {
      if (document.caretRangeFromPoint) { var r = document.caretRangeFromPoint(x, y); return r ? { n: r.startContainer, o: r.startOffset } : null; }
      if (document.caretPositionFromPoint) { var c = document.caretPositionFromPoint(x, y); return c ? { n: c.offsetNode, o: c.offset } : null; }
    } catch (e) {}
    return null;
  }
  function before(a, b) {
    if (a.n === b.n) return a.o <= b.o;
    return !!(a.n.compareDocumentPosition(b.n) & Node.DOCUMENT_POSITION_FOLLOWING);
  }
  function textUnder(pts) {
    var lo = null, hi = null, step = Math.max(1, Math.floor(pts.length / 40));
    for (var i = 0; i < pts.length; i += step) {
      var c = caretAt(pts[i][0] + origin.x - window.scrollX, pts[i][1] + origin.y - window.scrollY);
      if (!c || !c.n || c.n.nodeType !== 3 || inTools(c.n.parentNode)) continue;
      if (!lo || before(c, lo)) lo = c;
      if (!hi || before(hi, c)) hi = c;
    }
    if (!lo) return '';
    try {
      var r = document.createRange();
      r.setStart(lo.n, lo.o); r.setEnd(hi.n, hi.o);
      var s = squash(r.toString());
      if (!s) { var w = squash(lo.n.textContent); s = w.slice(Math.max(0, lo.o - 20), lo.o + 20); }
      return s.slice(0, 300);
    } catch (e) { return ''; }
  }
  function save(it) {
    api('POST', '', { data: it.data, author_label: it.author_label }).then(function (r) {
      it.id = r.ink && r.ink.id; it.failed = 0; markedUp();
      if (it.removed && it.id) { api('DELETE', '/' + it.id).catch(function () {}); return; }
      S.mine.push(it);
    }).catch(function (err) {
      it.failed = (it.failed || 0) + 1;
      if (/too large|too many/.test(String(err && err.message))) { msg('That mark was too big to save. Try shorter strokes.'); drop(it); return; }
      if (it.failed <= 6) { msg('Not saved yet. Retrying…'); setTimeout(function () { if (!it.removed) save(it); }, 2500 * it.failed); }
      else msg('Could not save a mark. Check the connection and draw it again.');
    });
  }
  function drop(it) {
    it.removed = true;
    var i = S.items.indexOf(it);
    if (i >= 0) S.items.splice(i, 1);
    if (it.path && it.path.parentNode) it.path.parentNode.removeChild(it.path);
    var j = S.mine.indexOf(it);
    if (j >= 0) S.mine.splice(j, 1);
    updateCount();
  }
  function remove(it) {
    drop(it);
    if (it.id) api('DELETE', '/' + it.id).catch(function () { msg('Could not erase that mark. Reload and try again.'); });
  }
  function eraseAt(e) {
    var p = pagePoint(e), best = null, bd = 14 * 14;
    for (var i = 0; i < S.items.length; i++) {
      var pts = S.items[i].pts;
      if (!pts) continue;
      for (var j = 0; j < pts.length; j++) {
        var dx = pts[j][0] - p[0], dy = pts[j][1] - p[1], d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = S.items[i]; }
      }
    }
    if (best) remove(best);
  }
  function undo() {
    var it = S.mine[S.mine.length - 1];
    if (!it) { msg('Nothing to undo from this visit.'); return; }
    remove(it);
  }
  // Pencil touches that draw must not scroll, select or start an iPadOS gesture (WebKit would then cancel the stroke); finger touches still scroll.
  function stylus(e) { var l = e.changedTouches || []; for (var i = 0; i < l.length; i++) if (l[i].touchType === 'stylus') return true; return false; }
  document.addEventListener('touchstart', function (e) { if (stylus(e) && pencilDraws(e.target)) e.preventDefault(); }, { passive: false, capture: true });
  document.addEventListener('touchmove', function (e) { if ((S.draw || S.erasing != null) && stylus(e)) e.preventDefault(); }, { passive: false, capture: true });
  // Two-finger tap = undo your last mark, as in Procreate and GoodNotes: Safari never passes the Pencil's own double-tap or squeeze to a
  // web page. Only a quick tap with both fingers still counts, so two-finger scrolling and pinch zoom are untouched.
  var tap2 = null;
  function fingers(list) { for (var i = 0; i < list.length; i++) if (list[i].touchType === 'stylus') return false; return true; }
  document.addEventListener('touchstart', function (e) {
    if (e.touches.length === 2 && fingers(e.touches) && (S.on || S.pencil) && !inTools(e.target)) {
      tap2 = { t: Date.now(), at: {} };
      for (var i = 0; i < e.touches.length; i++) tap2.at[e.touches[i].identifier] = [e.touches[i].clientX, e.touches[i].clientY];
    } else tap2 = null;
  }, { passive: true, capture: true });
  document.addEventListener('touchmove', function (e) {
    if (!tap2) return;
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i], a = tap2.at[t.identifier];
      if (!a || Math.abs(t.clientX - a[0]) + Math.abs(t.clientY - a[1]) > 12) { tap2 = null; return; }
    }
  }, { passive: true, capture: true });
  document.addEventListener('touchend', function (e) {
    if (!tap2 || e.touches.length) return;
    var quick = Date.now() - tap2.t < 350;
    tap2 = null;
    if (quick && S.mine.length) { undo(); msg('Undone (two-finger tap)', 1400); }
  }, { passive: true, capture: true });
  document.addEventListener('touchcancel', function () { tap2 = null; }, { passive: true, capture: true });
  document.addEventListener('pointerdown', onDown, { capture: true });
  document.addEventListener('pointermove', onMove, { capture: true });
  document.addEventListener('pointerup', onUp, { capture: true });
  document.addEventListener('pointercancel', onUp, { capture: true });
  // A drawn stroke must not also click a link, start a comment or select text.
  document.addEventListener('click', function (e) { if (S.on && !inTools(e.target) && Date.now() - S.lastOurs < 700) { e.preventDefault(); e.stopPropagation(); } }, true);
  document.addEventListener('selectstart', function (e) { if (S.on && !inTools(e.target)) e.preventDefault(); }, true);
  document.addEventListener('dragstart', function (e) { if (S.on) e.preventDefault(); }, true);
  document.addEventListener('keydown', function (e) {
    if (pal && e.key === 'Escape') { closePalette(); return; }
    if (!S.on) return;
    if (e.key === 'Escape') setOn(false);
    else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); undo(); }
  });

  /* ---------- toolbar ---------- */
  var ui = $('div', 'rl-ink-ui');
  ui.setAttribute('role', 'toolbar');
  ui.setAttribute('aria-label', 'Pen');
  var msgEl = null, msgTimer = 0;
  function msg(t, ms) {
    if (!msgEl) { msgEl = $('div', 'rl-ink-msg'); msgEl.setAttribute('role', 'status'); root.appendChild(msgEl); registerPin(msgEl, function () { var n = narrow(); return { side: 'right', x: inkRight(n), edge: 'bottom', y: n ? 110 : 120 }; }); }
    msgEl.textContent = t; msgEl.style.display = '';
    schedulePin();
    clearTimeout(msgTimer);
    msgTimer = setTimeout(function () { msgEl.style.display = 'none'; }, ms || 3200);
  }
  function btn(label, title, fn, cls) {
    var b = $('button', cls || '');
    b.type = 'button'; b.title = title; b.setAttribute('aria-label', title);
    if (typeof label === 'string') b.textContent = label; else b.appendChild(label);
    b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); fn(); });
    return b;
  }
  function dot(color) { var s = $('span', 'rl-ink-dot'); s.style.background = COLORS[color]; if (color === 'hl') s.style.border = '1px solid rgba(160,120,0,.6)'; return s; }
  var countEl = $('span', 'rl-ink-count');
  var mainIcon = $('span', 'rl-ink-icon'), mainLabel = $('span', '', 'Draw');
  mainIcon.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11.4 1.6a1.9 1.9 0 0 1 2.7 2.7l-8.6 8.6-3.7 1 1-3.7 8.6-8.6zM10.3 3.9l1.8 1.8"/></svg>';
  var mainBtn = $('button', 'rl-ink-main');
  mainBtn.type = 'button';
  var mainDot = $('span', 'rl-ink-dot'); // the pen a Pencil draws with while the toolbar is closed
  mainDot.style.boxShadow = '0 0 0 2px rgba(255,255,255,.9)';
  mainBtn.appendChild(mainIcon); mainBtn.appendChild(mainLabel); mainBtn.appendChild(mainDot); mainBtn.appendChild(countEl);
  mainBtn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); setOn(!S.on); });
  var toolBtns = {
    red: btn(dot('red'), 'Red pen', function () { setTool('red'); }),
    blue: btn(dot('blue'), 'Blue pen', function () { setTool('blue'); }),
    black: btn(dot('black'), 'Black pen', function () { setTool('black'); }),
    hl: btn(dot('hl'), 'Highlighter', function () { setTool('hl'); }),
    erase: btn('Erase', 'Eraser: touch a mark to remove it', function () { setTool('erase'); }),
  };
  function sizeDot(k) { var d = $('span', 'rl-ink-size'), px = { s: 4, m: 7, l: 11 }[k]; d.style.width = d.style.height = px + 'px'; return d; }
  var sizeBtns = {
    s: btn(sizeDot('s'), 'Fine pen', function () { setSize('s'); }),
    m: btn(sizeDot('m'), 'Medium pen', function () { setSize('m'); }),
    l: btn(sizeDot('l'), 'Bold pen', function () { setSize('l'); }),
  };
  var undoBtn = btn('Undo', 'Undo your last mark', undo);
  var hideBtn = btn('Hide', 'Hide or show all marks', function () { setHidden(!S.hidden); });
  var pencilBtn = btn('', 'Apple Pencil: draw even with this toolbar closed (fingers scroll and tap), or only in Draw mode', function () { setPencil(!S.pencil); });
  var extra = [toolBtns.red, toolBtns.blue, toolBtns.black, toolBtns.hl, sizeBtns.s, sizeBtns.m, sizeBtns.l, toolBtns.erase, undoBtn];
  if (navigator.maxTouchPoints > 0) extra.push(pencilBtn); // touch screens only: a Mac has no Pencil
  ui.appendChild(mainBtn);
  for (var i = 0; i < extra.length; i++) ui.appendChild(extra[i]);
  ui.appendChild(hideBtn);
  root.appendChild(ui);
  function setTool(t) {
    S.tool = t;
    for (var k in toolBtns) toolBtns[k].setAttribute('aria-pressed', String(k === t));
    mainDot.style.background = COLORS[t] || 'transparent';
    mainDot.style.display = S.on || t === 'erase' ? 'none' : '';
  }
  function setSize(k) {
    S.size = k;
    store('redline.ink.size', k);
    for (var q in sizeBtns) sizeBtns[q].setAttribute('aria-pressed', String(q === k));
  }
  function setPencil(on) {
    S.pencil = on;
    store('redline.ink.pencil', on ? '1' : '0');
    pencilBtn.textContent = on ? 'Pencil: always draws' : 'Pencil: only in Draw';
    pencilBtn.setAttribute('aria-pressed', String(on));
    if (!on) hideHover();
  }
  function setHidden(h) {
    S.hidden = h;
    document.documentElement.classList.toggle('rl-ink-hidden', h);
    hideBtn.textContent = h ? 'Show' : 'Hide';
    if (h && S.on) setOn(false);
  }
  function updateCount() {
    var n = S.items.length;
    countEl.textContent = String(n);
    countEl.style.display = n && !S.on ? '' : 'none';
    hideBtn.style.display = n || S.hidden ? '' : 'none';
    schedulePin(); // the toolbar may have changed width
  }
  function setOn(on) {
    S.on = on;
    document.documentElement.classList.toggle('rl-ink-on', on);
    mainLabel.textContent = on ? 'Done' : 'Draw';
    mainIcon.style.display = on ? 'none' : '';
    mainDot.style.display = on || S.tool === 'erase' ? 'none' : '';
    for (var i = 0; i < extra.length; i++) extra[i].style.display = on ? '' : 'none';
    if (on) {
      if (S.hidden) setHidden(false);
      try { if (window.getSelection) window.getSelection().removeAllRanges(); } catch (e) {}
      measureOrigin();
      if (!S.sawPen) msg('Draw with Apple Pencil, a pen or a mouse. Fingers still scroll. Marks save as you go.', 4200);
    } else if (S.draw) { finish(S.draw); S.draw = null; }
    updateCount();
    schedulePin(); // the toolbar changed width
  }
  try { if (window.matchMedia('(pointer: fine)').matches) document.documentElement.classList.add('rl-ink-fine'); } catch (e) {}
  setTool('red');
  setSize(S.size);
  setPencil(S.pencil);
  setOn(false);

  /* ---------- pinch zoom: the toolbar and messages stay at the bottom right of what is on screen (see "Pinning" at the end) ---------- */
  // Beside the comments panel while it is open (hidden behind it on a phone, where the panel is a bottom sheet).
  function inkRight(n) { return n ? 12 : 16 + (panelOpen() ? panelWidth() + 12 : 0); }
  registerPin(ui, function () { var n = narrow(); return { side: 'right', x: inkRight(n), edge: 'bottom', y: n ? 60 : 68 }; });
  onZoomChange(function () { closePalette(); hideHover(); });
  window.addEventListener('scroll', hideHover, { passive: true });

  /* ---------- loading ---------- */
  function load() {
    return api('GET', '').then(function (r) {
      var keep = S.items.filter(function (it) { return !it.id; }); // strokes still saving
      for (var i = 0; i < S.items.length; i++) if (S.items[i].id && S.items[i].path && S.items[i].path.parentNode) S.items[i].path.parentNode.removeChild(S.items[i].path);
      var mine = {};
      for (var m = 0; m < S.mine.length; m++) mine[S.mine[m].id] = true;
      S.items = (r.ink || []).filter(function (x) { return x.data; }).map(function (x) {
        return { id: x.id, data: x.data, path: null, pts: null, author_label: x.author_label, created_at: x.created_at };
      }).concat(keep);
      S.mine = S.items.filter(function (it) { return it.id && mine[it.id]; });
      layout();
    }).catch(function () { /* marks are an extra: the page works without them */ });
  }
  load();
  window.addEventListener('resize', relayout);
  window.addEventListener('load', relayout);
  try { if (document.fonts && document.fonts.ready) document.fonts.ready.then(relayout); } catch (e) {}
  try { new ResizeObserver(relayout).observe(document.body); } catch (e) {}
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && !S.draw) load(); });

  // For node ink.js (screenshots of each mark): the page box of every placed mark, in CSS pixels from the top of the document.
  window.__REDLINE_INK = {
    reload: load,
    boxes: function () {
      layout();
      return S.items.filter(function (it) { return it.pts && it.pts.length; }).map(function (it) {
        var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (var i = 0; i < it.pts.length; i++) {
          x0 = Math.min(x0, it.pts[i][0]); y0 = Math.min(y0, it.pts[i][1]); x1 = Math.max(x1, it.pts[i][0]); y1 = Math.max(y1, it.pts[i][1]);
        }
        return { id: it.id, author: it.author_label, created_at: it.created_at, color: it.data.c, anchor: it.data.a.t, x: x0 + origin.x, y: y0 + origin.y, w: x1 - x0, h: y1 - y0 };
      });
    },
    lost: function () { return S.items.filter(function (it) { return !it.pts; }).map(function (it) { return { id: it.id, anchor: it.data.a }; }); },
  };
  })();


  /* ================================ changes ================================ */
  // From the second version on, a "Changes" button joins the pen toolbar. Turned on, it marks the paragraphs whose text is new or different from
  // the version before, and a small box lists what was taken out. The comparison is made by the site when a version is published (text blocks,
  // not pixels), so a re-flowed or restyled page shows nothing. It opens by itself the first time a reader who marked up an earlier version
  // comes back to a newer one.
  (function () {
    // Remember which version this reader last looked at, on every version, so a later one can tell they have been here before.
    var seenKey = 'redline.seen.' + SLUG, seen = Number(lsGet(seenKey)) || 0;
    if (!(CFG.version > 1)) { lsSet(seenKey, String(CFG.version || 1)); return; }
    var ui = document.querySelector('.rl-ink-ui');
    if (!ui) return;
    var api = mkApi('/changes');
    var BLOCK_SEL = 'p,li,h1,h2,h3,h4,h5,h6,td,th,blockquote,figcaption,dt,dd,pre,summary,caption';
    var BLOCKISH = BLOCK_SEL + ',div,section,article,aside,ul,ol,table,tr,thead,tbody,tfoot,figure,details,nav,header,footer,main,form,dl,svg,hr';
    var LOOSE;
    try { LOOSE = new RegExp('[^\\p{L}\\p{N}]+', 'gu'); } catch (e) { LOOSE = /[^a-z0-9]+/g; }
    function key(t) { return String(t || '').toLowerCase().replace(LOOSE, '').slice(0, 80); }
    function squash(t) { return String(t || '').replace(/\s+/g, ' ').trim(); }
    function shorten(t, n) { return t.length > n ? t.slice(0, n - 1).replace(/\s+$/, '') + '\u2026' : t; }
    function inUi(el) { return !!(el.closest && el.closest(UI_SEL)); }

    var data = null, on = false, marked = [], missed = [], box = null, btn = null, label = null;

    // The first run of text in an element, up to its first block-level child: the way the site reads a page.
    function ownText(el) {
      var out = '';
      for (var n = el.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3) out += n.nodeValue;
        else if (n.nodeType === 1) {
          if (n.matches('script,style,template,noscript,' + UI_SEL)) continue;
          if (n.matches(BLOCKISH)) { if (squash(out)) break; continue; }
          out += n.textContent;
        }
      }
      return out;
    }

    function clear() {
      marked.forEach(function (el) { el.classList.remove('rl-chg', 'rl-chg-new', 'rl-chg-changed'); el.removeAttribute('data-rl-chg'); });
      marked = []; missed = [];
    }
    function paintPage() {
      clear();
      if (!data || !data.available) return;
      var map = {}, els = document.querySelectorAll(BLOCK_SEL), i;
      for (i = 0; i < els.length; i++) {
        if (inUi(els[i])) continue;
        var k = key(ownText(els[i]));
        if (k) (map[k] || (map[k] = [])).push(els[i]);
      }
      data.items.forEach(function (it) {
        var list = map[key(it.t)], el = list && list.shift();
        if (!el) { missed.push(it); return; }
        el.classList.add('rl-chg', 'rl-chg-' + it.k);
        el.setAttribute('data-rl-chg', it.k);
        marked.push(el);
      });
    }

    function line(parent, tag, cls, text) { var e = $(tag, cls, text); parent.appendChild(e); return e; }
    function paintBox() {
      if (!box) {
        box = $('aside', 'rl rl-chg-box'); box.setAttribute('aria-label', 'What changed');
        document.documentElement.appendChild(box);
        registerPin(box, function () {
          var n = narrow(), w = vv.width * vv.scale;
          return { side: 'right', x: n ? 12 : 16 + (panelOpen() ? panelWidth() + 12 : 0), edge: 'bottom', y: n ? 108 : 122, w: Math.min(330, w - 24), maxH: vv.height * vv.scale * 0.5 };
        });
      }
      box.textContent = '';
      box.hidden = !on;
      if (!on) return;
      var head = line(box, 'div', 'rl-chg-head');
      line(head, 'b', '', data && data.available ? 'Changed since version ' + data.from : 'What changed');
      var close = line(head, 'button', 'rl-link', 'Hide'); close.type = 'button'; close.onclick = function () { setOn(false); };
      if (!data) { line(box, 'p', 'rl-empty', 'Loading…'); return; }
      if (!data.available) { line(box, 'p', 'rl-empty', 'There is nothing to compare this version with yet. Changes show from the next version on.'); return; }
      var nNew = data.items.filter(function (x) { return x.k === 'new'; }).length, nCh = data.items.length - nNew;
      if (!data.items.length && !data.removed.length) { line(box, 'p', 'rl-empty', 'No text changed.'); return; }
      var tally = [];
      if (nCh) tally.push(nCh + ' changed'); if (nNew) tally.push(nNew + ' new'); if (data.removed.length) tally.push(data.removed.length + ' removed');
      line(box, 'p', 'rl-chg-tally', tally.join(', ') + '.');
      var key1 = line(box, 'p', 'rl-chg-key');
      line(key1, 'span', 'rl-chg-sw is-changed', 'Changed'); line(key1, 'span', 'rl-chg-sw is-new', 'New');
      function list(title, rows, withWas) {
        if (!rows.length) return;
        line(box, 'div', 'rl-sec', title);
        var ul = line(box, 'ul', 'rl-chg-list');
        rows.slice(0, 12).forEach(function (r) {
          var li = line(ul, 'li', '', shorten(r.t, 160));
          if (withWas && r.w) line(li, 'span', 'rl-chg-was', 'Was: ' + shorten(r.w, 120));
        });
        if (rows.length > 12) line(box, 'p', 'rl-empty', '…and ' + (rows.length - 12) + ' more.');
      }
      list('Removed', data.removed, false);
      list('Also changed, where it could not be marked on the page', missed, true);
      schedulePin();
    }

    function setOn(v) {
      on = v;
      btn.setAttribute('aria-pressed', String(v));
      root.classList.toggle('rl-chg-on', v);
      if (v) paintPage(); else clear();
      paintBox();
      schedulePin();
    }

    btn = $('button', 'rl-chg-btn'); btn.type = 'button'; btn.setAttribute('aria-pressed', 'false');
    btn.title = 'Show what changed since the version before'; btn.setAttribute('aria-label', 'Show what changed since the version before');
    label = $('span', '', 'Changes'); btn.appendChild(label);
    btn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); setOn(!on); });
    ui.appendChild(btn);
    schedulePin();

    api('GET', '').then(function (r) {
      data = r;
      var n = (r.items || []).length + (r.removed || []).length;
      if (r.available && n) { var c = $('span', 'rl-ink-count', String(n)); c.style.display = 'inline-block'; btn.appendChild(c); }
      schedulePin();
      if (on) { paintPage(); paintBox(); }
      // The first visit to a newer version by someone who marked up an earlier one opens the changes for them.
      if (CFG.version > seen) {
        lsSet(seenKey, String(CFG.version));
        if (seen && seen < CFG.version && lsGet('redline.marked.' + SLUG) === '1' && r.available && n) setOn(true);
      }
    }).catch(function () {
      lsSet('redline.seen.' + SLUG, String(CFG.version));
    });
    var redo; function again() { clearTimeout(redo); redo = setTimeout(function () { if (on) paintPage(); }, 300); }
    window.addEventListener('load', again);
    try { if (document.fonts && document.fonts.ready) document.fonts.ready.then(again); } catch (e) {}
    window.__REDLINE_CHANGES = { toggle: function (v) { setOn(v === undefined ? !on : !!v); }, marked: function () { return marked.length; } };
  })();

  /* ================================ decisions ================================ */
  // Approve / Reject / Not sure under the first heading of every [data-redline-decision="<id>"] element, or one whole-document bar
  // (item "doc") at the end of the page when no element has the attribute. One click saves; the note saves when it loses focus.
  // Button labels are drawn with CSS (no text nodes), so the comment layer's text anchoring never sees the bar.
  (function () {
    var api = mkApi('/decisions');
    var LABEL = { approve: 'Approved', reject: 'Rejected', unsure: 'Not sure' };
    var BTN = [['approve', '✓ Approve', 'Approve'], ['reject', '✗ Reject', 'Reject'], ['unsure', '? Not sure', 'Not sure']];
    var NOTE_MAX = 1000, ID_MAX = 80;

    function ts(v) { var t = Date.parse((v && v.created_at) || ''); return isNaN(t) ? 0 : t; }

    function start() {
      var recs = {}, els = document.querySelectorAll('[data-redline-decision]'), any = false;
      for (var i = 0; i < els.length; i++) {
        var id = (els[i].getAttribute('data-redline-decision') || '').trim().slice(0, ID_MAX);
        if (!id || recs[id]) continue;
        recs[id] = { id: id, el: els[i], v: null, busy: false };
        build(recs[id]);
        any = true;
      }
      if (!any) { recs.doc = { id: 'doc', el: null, v: null, busy: false }; build(recs.doc); }
      load(recs);
    }

    function build(rec) {
      var bar = $('div', 'rl-dec' + (rec.el ? '' : ' rl-dec-doc'));
      bar.setAttribute('role', 'group'); bar.setAttribute('aria-label', rec.el ? 'Your decision on this section' : 'Your decision on this document');
      if (!rec.el) bar.appendChild($('div', 'rl-dec-title', 'Your decision on this document'));
      var row = $('div', 'rl-dec-row');
      BTN.forEach(function (b) {
        var btn = $('button', 'rl-dec-btn'); btn.type = 'button';
        btn.setAttribute('data-label', b[1]); btn.setAttribute('aria-label', b[2]); btn.setAttribute('data-v', b[0]); btn.setAttribute('aria-pressed', 'false');
        btn.addEventListener('click', function () { save(rec, b[0], null); });
        row.appendChild(btn);
      });
      var msg = $('span', 'rl-dec-msg'); msg.setAttribute('aria-live', 'polite'); row.appendChild(msg);
      bar.appendChild(row);
      var state = $('div', 'rl-dec-state'); state.hidden = true; bar.appendChild(state);
      var noteWrap = $('div', 'rl-dec-note');
      var inp = $('input'); inp.type = 'text'; inp.maxLength = NOTE_MAX; inp.placeholder = 'Add a note (optional)'; inp.setAttribute('aria-label', 'Optional note for your decision');
      inp.addEventListener('blur', function () { if (rec.v && inp.value.trim() !== (rec.v.note || '')) save(rec, rec.v.verdict, inp.value); });
      inp.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); inp.blur(); } });
      noteWrap.appendChild(inp); bar.appendChild(noteWrap);
      rec.bar = bar; rec.msg = msg; rec.state = state; rec.inp = inp;
      if (!rec.el) { (document.querySelector('main') || document.body).appendChild(bar); return; }
      var h = rec.el.matches('h1,h2,h3,h4,h5,h6') ? rec.el : rec.el.querySelector('h1,h2,h3,h4,h5,h6');
      if (h && h.parentNode) h.parentNode.insertBefore(bar, h.nextSibling); else rec.el.insertBefore(bar, rec.el.firstChild);
    }

    function paint(rec) {
      var cur = rec.v, stale = !!(cur && cur.stale);
      // An answer given on words that have changed since does not count: no button shows as chosen and the page asks again.
      [].forEach.call(rec.bar.querySelectorAll('.rl-dec-btn'), function (b) { b.setAttribute('aria-pressed', String(!!cur && !stale && b.getAttribute('data-v') === cur.verdict)); b.disabled = rec.busy; });
      rec.bar.classList.toggle('has', !!cur && !stale);
      rec.bar.classList.toggle('is-stale', stale);
      if (cur && !stale && document.activeElement !== rec.inp) rec.inp.value = cur.note || '';
      if (stale && document.activeElement !== rec.inp) rec.inp.value = '';
      rec.state.hidden = !cur;
      if (!cur) { rec.state.textContent = ''; return; }
      var by = (cur.author_label ? ' by ' + cur.author_label : '') + (cur.version ? ' on version ' + cur.version : '');
      rec.state.textContent = stale
        ? LABEL[cur.verdict] + by + '. ' + (rec.el ? 'This section' : 'This document') + ' has changed since. Decide again.'
        : LABEL[cur.verdict] + by + (cur.created_at ? ' \u00b7 ' + ago(cur.created_at) : '');
    }

    function say(rec, text, err) { rec.msg.textContent = text || ''; rec.msg.className = 'rl-dec-msg' + (err ? ' err' : ''); }

    function save(rec, verdict, note) {
      if (rec.busy) return;
      var body = { item: rec.id, verdict: verdict, note: (note == null ? rec.inp.value : String(note)).trim().slice(0, NOTE_MAX), author_label: getAuthor().slice(0, 60) };
      rec.busy = true; paint(rec); say(rec, 'Saving…');
      api('POST', '', body).then(function (r) {
        // Use what the server stored when it sends it back, otherwise what was sent.
        var v = r.decision || (r.verdict && typeof r.verdict === 'object' ? r.verdict : null) || { item: rec.id, verdict: verdict, note: body.note, author_label: body.author_label, created_at: new Date().toISOString() };
        rec.busy = false; rec.v = v; markedUp(); paint(rec); say(rec, 'Saved');
        setTimeout(function () { if (rec.msg.textContent === 'Saved') say(rec, ''); }, 2500);
      }).catch(function (err) {
        rec.busy = false; paint(rec); say(rec, err && err.message ? 'Could not save: ' + err.message : 'Could not save. Try again.', true);
      });
    }

    // The newest decision per item wins.
    function load(recs) {
      api('GET', '').then(function (j) {
        (j.decisions || []).forEach(function (v) {
          var rec = recs[v.item];
          if (rec && (!rec.v || ts(v) > ts(rec.v) || (ts(v) === ts(rec.v) && v.id > rec.v.id))) rec.v = v;
        });
        Object.keys(recs).forEach(function (id) { paint(recs[id]); });
      }).catch(function () { /* decisions are an extra: the page works without them */ });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  })();

  /* ================================ Download PDF ================================ */
  // With a PDF published alongside the page, downloads it; otherwise opens the print dialog (Save as PDF). Print CSS hides every layer.
  (function () {
    var btn = $('button', 'rl rl-pdf');
    btn.type = 'button'; btn.setAttribute('aria-label', 'Download PDF'); btn.title = 'Download PDF';
    btn.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5v8.2M4.6 6.6 8 10l3.4-3.4M2.5 13.2h11"/></svg><span class="rl-pdf-label">Download PDF</span>';
    function fileName() {
      var n = String(CFG.title || '').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase().slice(0, 60);
      return (n || 'document') + '.pdf';
    }
    btn.addEventListener('click', function () {
      if (CFG.pdf) {
        try {
          var a = document.createElement('a');
          a.href = new URL(String(CFG.pdf), location.href).href; a.download = fileName(); a.rel = 'noopener';
          root.appendChild(a); a.click(); root.removeChild(a);
          return;
        } catch (e) { /* fall through to printing */ }
      }
      window.print();
    });
    root.appendChild(btn);
    registerPin(btn, function () { var n = narrow(); return { side: 'left', x: n ? 12 : 16, edge: 'bottom', y: n ? 12 : 16 }; });
  })();
})();
