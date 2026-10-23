// Turns the writer's answer into things the page can show. Every piece of
// model text is escaped before any markup is added, so nothing it writes can
// become a tag; links only render when they are site paths or https URLs.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

/** The Markdown inside section 5's fenced block, frontmatter removed. */
export function pageCopy(copyDoc) {
  const at = copyDoc.indexOf('## 5. Page copy');
  if (at < 0) return '';
  const open = copyDoc.indexOf('```markdown\n', at);
  if (open < 0) return '';
  const start = open + '```markdown\n'.length;
  const close = copyDoc.indexOf('\n```', start);
  const md = copyDoc.slice(start, close < 0 ? undefined : close);
  return md.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
}

/** The frontmatter of section 5 as key/value pairs. */
export function frontmatter(copyDoc) {
  const at = copyDoc.indexOf('```markdown\n---\n', copyDoc.indexOf('## 5. Page copy'));
  if (at < 0) return {};
  const start = at + '```markdown\n---\n'.length;
  const end = copyDoc.indexOf('\n---\n', start);
  const out = {};
  for (const line of copyDoc.slice(start, end).split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function inline(text) {
  let s = escapeHtml(text);
  s = s.replace(/\[CONFIRM:([^\]]*)\]/g, '<mark class="confirm">[CONFIRM:$1]</mark>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
    const raw = url.replace(/&amp;/g, '&');
    if (!/^(\/|https:\/\/)/.test(raw)) return label;
    return `<a href="${url}" target="_blank" rel="noopener nofollow">${label}</a>`;
  });
  return s;
}

/** A small Markdown reader for the preview: headings, paragraphs, lists, bold, links. */
export function renderMarkdown(md) {
  const out = [];
  let para = [];
  let list = null;
  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  for (const line of md.split('\n')) {
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      flushList();
      const n = h[1].length;
      out.push(`<h${n}>${inline(h[2])}</h${n}>`);
    } else if (ul || ol) {
      flushPara();
      const tag = ul ? 'ul' : 'ol';
      if (list && list.tag !== tag) flushList();
      list ||= { tag, items: [] };
      list.items.push((ul || ol)[1]);
    } else if (!line.trim()) {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return out.join('\n');
}

/** Words in the page copy, the way a reader would count them. */
export const wordCount = (md) => (md.replace(/[#*>\[\]()_`-]/g, ' ').match(/[A-Za-z0-9']+/g) || []).length;

/** Splits a check report into rows of { level, area, text }. */
export function reportRows(report) {
  return String(report || '')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const m = /^(PASS|FAIL|WARN|INFO)\s+(\S+)\s+(.*)$/.exec(line);
      return m ? { level: m[1], area: m[2], text: m[3] } : { level: 'INFO', area: '', text: line };
    });
}
