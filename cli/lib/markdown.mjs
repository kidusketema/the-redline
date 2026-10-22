// Turns a Markdown file into one clean review page, in the same style as examples/sample-plan.html.
// The Markdown parser is `marked` (MIT), in ../vendor.
import { Marked } from '../vendor/marked.esm.js';
import { CliError } from './common.mjs';

const DECISION = /<!--\s*redline:decision\s+([A-Za-z0-9_-]{1,40})\s*-->/;
const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const CSS = `
  :root {
    --bg: #fbfaf7; --card: #ffffff; --ink: #1f2328; --muted: #5f6670; --line: #dcd8cf; --accent: #b4412c; --soft: #f3efe7;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #17191c; --card: #1f2226; --ink: #e8e6e1; --muted: #a2a8b0; --line: #34383d; --accent: #f08a73; --soft: #23272b; }
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 18px/1.65 ui-serif, Georgia, "Iowan Old Style", "Times New Roman", serif;
  }
  main { max-width: 41rem; margin: 0 auto; padding: 40px 16px 96px; }
  header { margin-bottom: 36px; }
  h1 { font: 700 2rem/1.2 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif; margin: 0 0 10px; letter-spacing: -0.01em; }
  h2 { font: 650 1.3rem/1.3 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif; margin: 0 0 10px; }
  h3, h4, h5, h6 { font: 650 1.05rem/1.35 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif; margin: 22px 0 8px; }
  section { padding: 28px 0; border-top: 1px solid var(--line); }
  section.intro { border-top: 0; padding-top: 0; }
  p, ul, ol, pre, blockquote { margin: 0 0 14px; }
  ul, ol { padding-left: 1.4em; }
  li { margin: 0 0 4px; }
  a { color: var(--accent); }
  img { max-width: 100%; height: auto; }
  hr { border: 0; border-top: 1px solid var(--line); margin: 24px 0; }
  blockquote { background: var(--soft); border-left: 4px solid var(--accent); padding: 10px 16px; border-radius: 0 6px 6px 0; }
  blockquote > :last-child { margin-bottom: 0; }
  code { font: 0.88em ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--soft); padding: 1px 5px; border-radius: 4px; }
  pre { background: var(--soft); padding: 12px 16px; border-radius: 6px; overflow-x: auto; line-height: 1.5; }
  pre code { background: none; padding: 0; font-size: 0.85rem; }
  .scroll { overflow-x: auto; margin: 12px 0 14px; }
  table { border-collapse: collapse; width: 100%; min-width: 24rem; font: 0.92rem/1.45 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif; }
  th, td { text-align: left; padding: 9px 12px 9px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; }
  @media print { body { background: #fff; color: #000; } }
`;

// Strips tags and decodes the few entities `marked` writes, for the page title.
const plainText = (html) => html.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

const LOCAL_IMG = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/)/i;
export const isRelativeLink = (href) => !!href && !LOCAL_IMG.test(href);

/**
 * @param {string} source Markdown text
 * @param {{ rewriteImage?: (href: string) => string | null, fallbackTitle?: string, title?: string }} options
 * @returns {{ html: string, title: string, decisions: string[] }}
 */
export function renderMarkdown(source, { rewriteImage, fallbackTitle = 'Untitled', title } = {}) {
  const marked = new Marked({ gfm: true, breaks: false });
  const tokens = marked.lexer(String(source).replace(/^﻿/, ''));
  const links = tokens.links;

  // The first top-level heading becomes the page title.
  let heading = '';
  const h1 = tokens.findIndex((t) => t.type === 'heading' && t.depth === 1);
  if (h1 >= 0) {
    heading = plainText(marked.parseInline(tokens[h1].text));
    tokens.splice(h1, 1);
  }

  // Sections start at each level-2 heading. Whatever comes before the first one is the introduction.
  const groups = [{ intro: true, tokens: [] }];
  for (const t of tokens) {
    if (t.type === 'heading' && t.depth === 2) groups.push({ intro: false, tokens: [t] });
    else groups[groups.length - 1].tokens.push(t);
  }

  const seen = new Set();
  const sections = [];
  for (const g of groups) {
    if (!g.tokens.some((t) => t.type !== 'space')) continue;
    const found = DECISION.exec(g.tokens.map((t) => t.raw).join(''));
    const id = found ? found[1] : '';
    if (id) {
      if (seen.has(id)) throw new CliError('The decision id "' + id + '" is used in two sections.', 'Give each <!-- redline:decision ... --> comment its own short id.');
      seen.add(id);
    }
    if (rewriteImage) {
      marked.walkTokens(g.tokens, (t) => {
        if (t.type === 'image' && isRelativeLink(t.href)) {
          const next = rewriteImage(t.href);
          if (next) t.href = next;
        } else if (t.type === 'html' && /<img\b/i.test(t.text || '')) {
          t.text = t.text.replace(/(<img\b[^>]*?\bsrc\s*=\s*)(["'])(.*?)\2/gi, (all, pre, q, src) => {
            const next = isRelativeLink(src) ? rewriteImage(src) : null;
            return next ? pre + q + next + q : all;
          });
        }
      });
    }
    g.tokens.links = links;
    let body = marked.parser(g.tokens);
    body = body.replace(/<table>/g, '<div class="scroll"><table>').replace(/<\/table>/g, '</table></div>');
    const attrs = (g.intro ? ' class="intro"' : '') + (id ? ' data-redline-decision="' + escapeHtml(id) + '"' : '');
    sections.push('<section' + attrs + '>\n' + body.trim() + '\n</section>');
  }

  const pageTitle = title || heading || fallbackTitle;
  const html = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<title>' + escapeHtml(pageTitle) + '</title>\n<style>' + CSS + '</style>\n</head>\n<body>\n<main>\n' +
    '<header>\n  <h1>' + escapeHtml(heading || pageTitle) + '</h1>\n</header>\n\n' + sections.join('\n\n') + '\n</main>\n</body>\n</html>\n';
  return { html, title: pageTitle, decisions: [...seen] };
}
