// The owner's dashboard at /d/<DASHBOARD_TOKEN>/ and the small public pages (home, 404). Server-rendered, no external requests.
import { esc, html } from "./util.js";

const VERDICT_LABEL = { approve: "Approved", reject: "Rejected", unsure: "Not sure" };
const VERDICT_PLURAL = { approve: "approved", reject: "rejected", unsure: "not sure" };

const BASE_CSS = `
:root{color-scheme:light dark;--bg:#f7f6f3;--card:#fff;--ink:#1c1b19;--mute:#6b675f;--line:#e6e3dc;--link:#9a2a1f;--accent:#c0392b;
--ok:#1e6b3c;--okbg:#e3f3e8;--no:#9c2a22;--nobg:#fbe5e2;--maybe:#7a5a0a;--maybebg:#faf0d3;--none:#5f5b54;--nonebg:#eeece7}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--card:#1f1f1c;--ink:#ecebe7;--mute:#a09c93;--line:#33322d;--link:#ff8d80;--accent:#ff6b5b;
--ok:#7fd69f;--okbg:#17301f;--no:#ff9a8f;--nobg:#3a1c19;--maybe:#e8c870;--maybebg:#352b0e;--none:#b3afa6;--nonebg:#2a2926}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-text-size-adjust:100%}
a{color:var(--link)}
`;

const page = (title, css, body) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title><style>${BASE_CSS}${css}</style></head><body>${body}</body></html>`;

const PLAIN_CSS = `main{max-width:34rem;margin:0 auto;padding:18vh 16px 16px}p{margin:0 0 .6rem}`;

export function homePage() {
  return html(page("The Redline", PLAIN_CSS,
    `<main><p>A private review site running The Redline.</p><p><a href="https://github.com/kidusketema/the-redline">github.com/kidusketema/the-redline</a></p></main>`));
}

export function notFoundPage() {
  return html(page("Not found", PLAIN_CSS, `<main><p>This page doesn't exist or was removed.</p></main>`), 404);
}

const DASH_CSS = `
header{max-width:62rem;margin:0 auto;padding:28px 16px 8px;display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 16px}
h1{font-size:1.35rem;margin:0;letter-spacing:-.01em}h1 span{color:var(--accent)}
.count{color:var(--mute);font-size:.95rem}
.tools{max-width:62rem;margin:0 auto;padding:8px 16px 14px}
#q{width:100%;font:inherit;padding:10px 14px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--ink)}
#q:focus{outline:2px solid var(--accent);outline-offset:1px}
main{max-width:62rem;margin:0 auto;padding:0 16px 40px}
.row{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,1.3fr) minmax(0,1.3fr) minmax(0,1.4fr) 5.5rem 5.5rem;gap:4px 14px;align-items:center;
background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 16px;margin:0 0 10px}
.row.head{background:none;border:0;padding:0 16px 2px;margin:0;color:var(--mute);font-size:.8rem;text-transform:uppercase;letter-spacing:.04em}
.row.head div:nth-child(n+5){text-align:right}
.title{font-weight:650;overflow-wrap:anywhere}
.title a{color:var(--ink);text-decoration:none}.title a:hover,.title a:focus-visible{text-decoration:underline}
.badge{display:inline-block;margin-left:8px;padding:1px 9px;border-radius:99px;background:var(--accent);color:#fff;font-size:.74rem;font-weight:650;vertical-align:1px;white-space:nowrap}
@media (prefers-color-scheme:dark){.badge{color:#1a0a07}}
.sub{color:var(--mute);font-size:.88rem;overflow-wrap:anywhere}
.num{text-align:right;font-variant-numeric:tabular-nums}
.label{display:inline-block;padding:2px 10px;border-radius:99px;font-size:.82rem;font-weight:650;white-space:nowrap}
.l-approve{background:var(--okbg);color:var(--ok)}.l-reject{background:var(--nobg);color:var(--no)}
.l-unsure{background:var(--maybebg);color:var(--maybe)}.l-none{background:var(--nonebg);color:var(--none)}
.tally{display:block;color:var(--mute);font-size:.78rem;margin-top:2px}
.empty{background:var(--card);border:1px dashed var(--line);border-radius:12px;padding:36px 16px;text-align:center;color:var(--mute)}
.none-found{display:none;text-align:center;color:var(--mute);padding:24px 0}
.m{display:none}
@media (max-width:720px){
  .row.head{display:none}
  .row{grid-template-columns:1fr auto;padding:12px 14px}
  .row .title{grid-column:1/-1;font-size:1.02rem}
  .row .project{grid-column:1/-1}.row .project:empty{display:none}
  .row .when{grid-column:1}.row .dec{grid-column:2;text-align:right}
  .row .num{text-align:left}.row .num.c{grid-column:1}.row .num.p{grid-column:2;text-align:right}
  .m{display:inline;color:var(--mute)}
}
`;

// The search box hides rows that do not match; times are shown in the viewer's own time zone.
const DASH_JS = `
(function(){
  var q=document.getElementById("q"),rows=[].slice.call(document.querySelectorAll(".row[data-s]")),none=document.getElementById("none");
  q.addEventListener("input",function(){
    var t=q.value.trim().toLowerCase(),n=0;
    rows.forEach(function(r){var show=!t||r.getAttribute("data-s").indexOf(t)>-1;r.style.display=show?"":"none";if(show)n++;});
    none.style.display=n||!rows.length?"none":"block";
  });
  [].forEach.call(document.querySelectorAll("time[datetime]"),function(el){
    var d=new Date(el.getAttribute("datetime"));
    if(!isNaN(d))el.textContent=d.toLocaleString(undefined,{day:"numeric",month:"short",hour:"numeric",minute:"2-digit"});
  });
})();
`;

function decisionCell(decisions) {
  if (!decisions.length) return `<span class="label l-none">No decision yet</span>`;
  const newest = decisions.reduce((a, b) => (b.id > a.id ? b : a));
  let tally = "";
  if (decisions.length > 1) {
    const counts = {};
    for (const d of decisions) counts[d.verdict] = (counts[d.verdict] || 0) + 1;
    tally = `<span class="tally">${Object.keys(VERDICT_PLURAL).filter((v) => counts[v]).map((v) => `${counts[v]} ${VERDICT_PLURAL[v]}`).join(", ")}</span>`;
  }
  // An answer given on words that have changed since does not count as an answer any more.
  const stale = decisions.filter((d) => d.stale).length;
  if (stale) {
    const extra = `${stale} ${stale === 1 ? "needs" : "need"} another look`;
    tally = `<span class="tally">${tally ? tally.replace(/^<span class="tally">|<\/span>$/g, "") + ", " : ""}${extra}</span>`;
    if (newest.stale) return `<span class="label l-unsure">Needs another look</span>${tally}`;
  }
  return `<span class="label l-${esc(newest.verdict)}">${esc(VERDICT_LABEL[newest.verdict] || newest.verdict)}</span>${tally}`;
}

const timeTag = (iso) => `<time datetime="${esc(iso)}">${esc(String(iso).slice(0, 10))}</time>`;

function row(d) {
  const search = [d.title, d.project, d.summary, ...d.tags].join(" ").toLowerCase();
  const open = d.open_comments, ink = d.ink_strokes;
  const states = [d.fixed_comments ? `${d.fixed_comments} marked fixed` : "", d.done_comments ? `${d.done_comments} confirmed` : ""].filter(Boolean).join(", ");
  return `<div class="row" data-s="${esc(search)}">` +
    `<div class="title"><a href="/${esc(d.slug)}/">${esc(d.title)}</a>${d.new_feedback ? `<span class="badge">New feedback</span>` : ""}</div>` +
    `<div class="sub project">${esc(d.project)}</div>` +
    `<div class="sub when"><span class="m">Updated </span>${timeTag(d.updated_at)}</div>` +
    `<div class="dec">${decisionCell(d.decisions)}</div>` +
    `<div class="num c" title="Open comments">${open}<span class="m"> open ${open === 1 ? "comment" : "comments"}</span>${states ? `<span class="tally">${esc(states)}</span>` : ""}</div>` +
    `<div class="num p" title="Pen marks">${ink}<span class="m"> pen ${ink === 1 ? "mark" : "marks"}</span></div>` +
    `</div>`;
}

export function dashboardPage(docs) {
  const body =
    `<header><h1>The <span>Redline</span></h1><span class="count">${docs.length} ${docs.length === 1 ? "document" : "documents"}</span></header>` +
    (docs.length
      ? `<div class="tools"><input id="q" type="search" placeholder="Search by title or project" aria-label="Search documents" autocomplete="off"></div>` +
        `<main><div class="row head"><div>Title</div><div>Project</div><div>Updated</div><div>Latest decision</div><div>Comments</div><div>Pen marks</div></div>` +
        docs.map(row).join("") + `<div class="none-found" id="none">No documents match.</div></main>`
      : `<main><div class="empty">Nothing published yet. Ask Claude to publish something for review.</div></main>`);
  const script = docs.length ? `<script>${DASH_JS}</script>` : "";
  return html(page("The Redline", DASH_CSS, body).replace("</body>", `${script}</body>`));
}
