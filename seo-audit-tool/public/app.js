// Renders the audit report. Page-derived text is only ever added as text
// nodes, never parsed as markup, so nothing from an audited site can run here.

const form = document.getElementById('audit-form');
const input = document.getElementById('url');
const button = document.getElementById('run');
const statusEl = document.getElementById('status');
const reportEl = document.getElementById('report');

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

const PRIORITY = { high: 'High', medium: 'Medium', low: 'Low' };

function renderIssue(i) {
  const pr = PRIORITY[i.priority] || 'Low';
  const priorityText = i.source === 'judgment' ? `${pr} (AI judgment, ${Math.round((i.confidence || 0) * 100)}% confidence)` : pr;
  return el(
    'article',
    { class: `issue p-${i.priority in PRIORITY ? i.priority : 'low'}` },
    el('h4', {}, i.issue),
    el(
      'dl',
      {},
      el('dt', {}, 'Issue'), el('dd', {}, i.issue),
      el('dt', {}, 'Impact'), el('dd', {}, i.impact),
      el('dt', {}, 'Evidence'), el('dd', {}, i.evidence),
      el('dt', {}, 'Fix'), el('dd', {}, i.fix),
      el('dt', {}, 'Priority'), el('dd', {}, priorityText),
    ),
  );
}

function download(name, type, text) {
  const blob = new Blob([text], { type });
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

function renderReport(r) {
  reportEl.replaceChildren();
  const host = (() => {
    try {
      return new URL(r.finalUrl).hostname;
    } catch {
      return 'site';
    }
  })();
  reportEl.append(
    el('h2', {}, 'Results for ', r.finalUrl),
    el('p', { class: 'score' }, `${r.score}/100 (${r.grade})`),
    el('p', { class: 'muted' }, `${r.counts.high} high, ${r.counts.medium} medium, ${r.counts.low} low priority issues. ${r.counts.passed} checks passed. ${r.pagesCrawled} page(s) crawled in ${Math.round(r.durationMs / 100) / 10}s.`),
  );
  if (r.judgment) {
    reportEl.append(el('p', { class: 'muted' }, r.judgment.used ? 'AI judgment checks ran on the content.' : r.judgment.error || 'AI judgment did not run.'));
  }
  const actions = el('div', { class: 'actions' });
  const jsonBtn = el('button', { type: 'button' }, 'Download JSON');
  jsonBtn.addEventListener('click', () => download(`seo-audit-${host}.json`, 'application/json', JSON.stringify(r, null, 2)));
  actions.append(jsonBtn);
  reportEl.append(actions);

  const table = el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Area'), el('th', {}, 'Score'), el('th', {}, 'Issues'))));
  const tbody = el('tbody');
  for (const c of r.categories) tbody.append(el('tr', {}, el('td', {}, c.name), el('td', {}, c.score), el('td', {}, c.issues)));
  table.append(tbody);
  reportEl.append(table);

  for (const p of ['high', 'medium', 'low']) {
    const items = r.issues.filter((i) => i.priority === p);
    if (!items.length) continue;
    reportEl.append(el('h3', {}, `${PRIORITY[p]} priority (${items.length})`));
    for (const i of items) reportEl.append(renderIssue(i));
  }
  if (r.insights.length) {
    reportEl.append(el('h3', {}, 'Notes'));
    const ul = el('ul');
    for (const n of r.insights) ul.append(el('li', {}, `${n.label}: ${n.value}`));
    reportEl.append(ul);
  }
  if (r.passed.length) {
    reportEl.append(el('h3', {}, `Passed (${r.passed.length})`));
    const ul = el('ul', { class: 'passed' });
    for (const p of r.passed) ul.append(el('li', {}, p.label));
    reportEl.append(ul);
  }
  if (r.pages.length > 1) {
    reportEl.append(el('h3', {}, 'Pages crawled'));
    const t = el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'URL'), el('th', {}, 'Status'), el('th', {}, 'Title'))));
    const b = el('tbody');
    for (const pg of r.pages) b.append(el('tr', {}, el('td', {}, pg.url), el('td', {}, pg.status || pg.error || ''), el('td', {}, pg.title || '')));
    t.append(b);
    reportEl.append(t);
  }
  reportEl.hidden = false;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = input.value.trim();
  if (!url) return;
  button.disabled = true;
  reportEl.hidden = true;
  statusEl.textContent = 'Running the audit. This can take up to a minute.';
  try {
    const res = await fetch('/api/audit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      statusEl.textContent = typeof data.error === 'string' ? data.error : `The audit failed (${res.status}).`;
      return;
    }
    statusEl.textContent = '';
    renderReport(data.report);
  } catch {
    statusEl.textContent = 'Could not reach the audit server.';
  } finally {
    button.disabled = false;
  }
});
