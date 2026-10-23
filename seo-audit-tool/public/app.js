// The audit app page. Page-derived text is only ever added as text nodes,
// never parsed as markup, so nothing from an audited site can run here.

const $ = (id) => document.getElementById(id);
const form = $('audit-form');
const input = $('url');
const button = $('run');
const statusEl = $('status');
const reportEl = $('report');

const state = { user: null, siteKey: null, billingEnabled: false, widgets: {} };

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
      el('dt', {}, 'Fix'), i.locked ? el('dd', { class: 'locked' }, 'Included with the $5 plan.') : el('dd', {}, i.fix),
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
  if (r.limited) {
    const box = el('div', { class: 'upsell' },
      el('p', {}, `This free audit shows the top ${r.issues.length} issues. ${r.lockedFixes} more fixes are in the full report.`),
    );
    if (state.billingEnabled) {
      const b = el('button', { type: 'button' }, 'Unlock everything for $5 a month');
      b.addEventListener('click', upgrade);
      box.append(b);
    }
    reportEl.append(box);
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

// --- talking to the server ----------------------------------------------

async function api(path, body) {
  const init = body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  let res;
  try {
    res = await fetch(path, { credentials: 'same-origin', ...init });
  } catch {
    return { ok: false, status: 0, data: { error: 'Could not reach the server.' } };
  }
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

const message = (data, fallback) => (typeof data?.error === 'string' ? data.error : fallback);

// Payment pages must be Stripe's own, never a link from anywhere else.
function goToStripe(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' && (u.hostname === 'checkout.stripe.com' || u.hostname === 'billing.stripe.com')) {
      location.assign(u.href);
      return;
    }
  } catch {}
  statusEl.textContent = 'Something went wrong opening the payment page.';
}

// --- human check (Cloudflare Turnstile) -------------------------------

let turnstileLoading;
function loadTurnstile() {
  if (!turnstileLoading) {
    turnstileLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true;
      s.onload = () => resolve(window.turnstile);
      s.onerror = reject;
      document.head.append(s);
    });
  }
  return turnstileLoading;
}

async function showHumanCheck(name) {
  if (!state.siteKey || state.widgets[name]) return;
  const ts = await loadTurnstile().catch(() => null);
  if (!ts) return;
  const slot = { token: '' };
  slot.id = ts.render($(`ts-${name}`), {
    sitekey: state.siteKey,
    callback: (t) => { slot.token = t; },
    'expired-callback': () => { slot.token = ''; },
  });
  state.widgets[name] = slot;
}

// Tokens work once, so each one is cleared after it is sent.
function takeHumanToken(name) {
  const slot = state.widgets[name];
  if (!slot) return undefined;
  const t = slot.token;
  slot.token = '';
  window.turnstile?.reset(slot.id);
  return t || undefined;
}

// --- account ------------------------------------------------------------

function renderAccount() {
  const u = state.user;
  $('account').hidden = !u;
  $('footer').hidden = !u;
  $('signin').hidden = Boolean(u);
  if (!u) {
    showHumanCheck('signin');
    $('watch').hidden = true;
    $('history').hidden = true;
    return;
  }
  $('account-email').textContent = u.email;
  const pro = u.plan === 'pro';
  $('account-plan').textContent = pro
    ? `$5 plan: ${u.runsLeft} of ${u.runsPerMonth} audits left, renews ${new Date(u.periodEnd).toLocaleDateString()}`
    : u.freeUsed ? 'Free audit used' : 'Your first audit is free';
  $('upgrade').hidden = pro || !state.billingEnabled;
  $('billing').hidden = !u.hasBilling || !state.billingEnabled;
  $('watch').hidden = !pro;
  $('watch-url').value = u.watchUrl || '';
  $('watch-status').textContent = u.watchUrl ? `Checking ${u.watchUrl} every week.` : 'No site saved yet.';
  if (!pro) showHumanCheck('audit');
  if (pro) loadHistory();
  else $('history').hidden = true;
}

async function loadMe() {
  const { ok, data } = await api('/api/me');
  if (!ok) return;
  state.user = data.user;
  state.siteKey = data.turnstileSiteKey;
  state.billingEnabled = data.billingEnabled;
  renderAccount();
}

async function loadHistory() {
  const { ok, data } = await api('/api/audits');
  if (!ok) return;
  const list = $('history-list');
  list.replaceChildren();
  for (const a of data.audits) {
    const open = el('button', { type: 'button' }, 'Open');
    open.addEventListener('click', () => openAudit(a.id));
    const when = new Date(a.created_at).toLocaleString();
    list.append(el('li', {}, `${a.url} · ${a.score ?? '?'}/100 · ${when}${a.kind === 'weekly' ? ' · weekly check' : ''}`, open));
  }
  $('history').hidden = !data.audits.length;
}

async function openAudit(id) {
  const { ok, data } = await api(`/api/audits/${encodeURIComponent(id)}`);
  if (!ok) {
    statusEl.textContent = message(data, 'Could not open that audit.');
    return;
  }
  statusEl.textContent = '';
  renderReport(data.report);
  reportEl.scrollIntoView({ behavior: 'smooth' });
}

async function upgrade() {
  const { ok, data } = await api('/api/billing/checkout', {});
  if (ok) goToStripe(data.url);
  else statusEl.textContent = message(data, 'Could not start the payment.');
}

$('upgrade').addEventListener('click', upgrade);

$('billing').addEventListener('click', async () => {
  const { ok, data } = await api('/api/billing/portal', {});
  if (ok) goToStripe(data.url);
  else statusEl.textContent = message(data, 'Could not open billing.');
});

$('signout').addEventListener('click', async () => {
  await api('/api/auth/logout', {});
  state.user = null;
  reportEl.hidden = true;
  renderAccount();
});

$('delete-account').addEventListener('click', async () => {
  if (!window.confirm('Delete your account and all saved audits? This cannot be undone.')) return;
  const { ok, data } = await api('/api/account/delete', {});
  statusEl.textContent = ok ? 'Your account is deleted.' : message(data, 'Could not delete the account.');
  if (ok) {
    state.user = null;
    reportEl.hidden = true;
    renderAccount();
  }
});

$('signin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const b = $('signin-button');
  b.disabled = true;
  const { data } = await api('/api/auth/start', { email: $('email').value.trim(), turnstileToken: takeHumanToken('signin') });
  statusEl.textContent = message(data, data.message || 'Check your email for a sign-in link.');
  b.disabled = false;
});

// The emailed link is /#signin=<token>. The token never leaves this page
// until the person presses the button, so mail scanners that open links
// cannot use it up.
const signinToken = (location.hash.match(/^#signin=([A-Za-z0-9_-]{43})$/) || [])[1];
if (signinToken) {
  history.replaceState(null, '', location.pathname);
  $('finish-signin').hidden = false;
  $('finish-signin-button').addEventListener('click', async () => {
    const { ok, data } = await api('/api/auth/verify', { token: signinToken });
    $('finish-signin').hidden = true;
    statusEl.textContent = ok ? 'You are signed in.' : message(data, 'Could not sign in.');
    await loadMe();
  });
}

if (new URLSearchParams(location.search).get('paid') === '1') {
  history.replaceState(null, '', location.pathname);
  statusEl.textContent = 'Thanks. Your plan turns on as soon as the payment is confirmed.';
  let tries = 0;
  const poll = setInterval(async () => {
    await loadMe();
    if (state.user?.plan === 'pro' || ++tries > 10) {
      clearInterval(poll);
      if (state.user?.plan === 'pro') statusEl.textContent = 'Your $5 plan is on.';
    }
  }, 3000);
}

$('watch-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { ok, data } = await api('/api/watch', { url: $('watch-url').value.trim() });
  const later = ok && data.nextCheckAt > Date.now() + 3_600_000 ? ` First check on ${new Date(data.nextCheckAt).toISOString().slice(0, 10)}.` : '';
  $('watch-status').textContent = ok ? (data.watchUrl ? `Checking ${data.watchUrl} every week.${later}` : 'No site saved.') : message(data, 'Could not save.');
});

$('watch-clear').addEventListener('click', async () => {
  const { ok } = await api('/api/watch', { url: null });
  if (ok) {
    $('watch-url').value = '';
    $('watch-status').textContent = 'Weekly check stopped.';
  }
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = input.value.trim();
  if (!url) return;
  if (!state.user) {
    statusEl.textContent = 'Sign up with your email first. Your first audit is free.';
    $('email').focus();
    return;
  }
  button.disabled = true;
  reportEl.hidden = true;
  statusEl.textContent = 'Running the audit. This can take up to a minute.';
  const { ok, data } = await api('/api/audit', { url, turnstileToken: takeHumanToken('audit') });
  button.disabled = false;
  if (!ok) {
    statusEl.textContent = message(data, 'The audit failed.');
    if (data.upgrade && state.billingEnabled) $('upgrade').hidden = false;
    return;
  }
  statusEl.textContent = '';
  renderReport(data.report);
  await loadMe();
});

loadMe();
