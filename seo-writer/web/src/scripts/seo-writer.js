// The writer page: reads the brief form, sends it to the Worker, shows each
// step as it streams in, then the copy doc, the check report and the cost.

import { formToBrief, briefToForm, addFact, extraFields } from './brief-form.js';
import { escapeHtml, pageCopy, frontmatter, renderMarkdown, wordCount, reportRows } from './render.js';

const STEPS = {
  sitemap: ['Reading the sitemap', 'Link targets from sitemap.xml'],
  plan: ['Planning the page', 'Search, keywords, facts, sources and outline'],
  sources: ['Replacing sources', 'Some sources failed the quote check'],
  draft: ['Drafting', 'Copy, titles, subheads and calls to action'],
  edit: ['Editing', 'Anti-AI pass and E-E-A-T marks'],
  fix: ['Fixing check.py FAILs', 'Round'],
};

const DRAFT_KEY = 'seo-writer:brief';
const TOKEN_KEY = 'seo-writer:token';
const store = {
  get(area, k) {
    try {
      return window[area].getItem(k);
    } catch {
      return null;
    }
  },
  set(area, k, v) {
    try {
      window[area].setItem(k, v);
    } catch {}
  },
  del(area, k) {
    try {
      window[area].removeItem(k);
    } catch {}
  },
};

const money = (n) => `$${(Number(n) || 0).toFixed(n >= 1 ? 2 : 3)}`;
const clock = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function mountWriter(root) {
  const $ = (sel) => root.querySelector(sel);
  const form = $('[data-form]');
  const endpoint = root.dataset.endpoint || '';
  const example = JSON.parse(root.dataset.example || '{}');
  const jsonBox = $('[data-json]');
  let extra = {};
  let server = null;
  let running = null;
  let lastDoc = null;

  // ----- status: is the writer set up, demo, or down?
  const statusEl = $('[data-status]');
  fetch(`${endpoint}/api/status`, { headers: { accept: 'application/json' } })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((s) => {
      server = s;
      if (s.demo) {
        statusEl.dataset.tone = 'demo';
        statusEl.textContent = 'Demo: sample page, no API calls';
      } else if (s.ready) {
        statusEl.dataset.tone = 'ready';
        statusEl.textContent = `${s.model}, stops at ${money(s.maxSpend)} a page`;
      } else {
        statusEl.dataset.tone = 'down';
        statusEl.textContent = 'Not set up';
        statusEl.title = s.reason || '';
      }
      $('[data-token-field]').hidden = !s.token;
    })
    .catch(() => {
      statusEl.dataset.tone = 'down';
      statusEl.textContent = 'Writer API not reachable';
    });
  const savedToken = store.get('sessionStorage', TOKEN_KEY);
  if (savedToken) form.elements.namedItem('token').value = savedToken;

  // ----- the form and its JSON twin
  const sync = () => {
    const brief = formToBrief(form, extra);
    jsonBox.value = JSON.stringify(brief, null, 2);
    store.set('localStorage', DRAFT_KEY, jsonBox.value);
    return brief;
  };
  const fill = (brief) => {
    extra = extraFields(brief);
    briefToForm(form, brief);
    sync();
  };
  form.addEventListener('input', (e) => {
    if (e.target === jsonBox || e.target.name === 'token') return;
    e.target.removeAttribute?.('aria-invalid');
    sync();
  });
  form.addEventListener('change', (e) => {
    if (e.target.name === 'page.type') sync();
  });
  form.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-remove-fact]');
    if (rm) {
      const rows = form.querySelectorAll('[data-fact]');
      if (rows.length > 1) rm.closest('[data-fact]').remove();
      else rows[0].querySelectorAll('input').forEach((i) => (i.value = ''));
      sync();
    }
  });
  $('[data-add-fact]').addEventListener('click', () => {
    addFact(form).querySelector('input').focus();
    sync();
  });
  $('[data-example-load]').addEventListener('click', () => fill(example));
  $('[data-clear]').addEventListener('click', () => {
    fill({});
    store.del('localStorage', DRAFT_KEY);
  });
  const jsonNote = $('[data-json-note]');
  $('[data-json-apply]').addEventListener('click', () => {
    try {
      const b = JSON.parse(jsonBox.value);
      if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error('not an object');
      fill(b);
      jsonNote.textContent = 'Form filled.';
    } catch (err) {
      jsonNote.textContent = `That is not a brief: ${err.message}`;
    }
  });
  $('[data-json-download]').addEventListener('click', () => save(jsonBox.value, `${sync().client || 'brief'}.json`, 'application/json'));

  const saved = store.get('localStorage', DRAFT_KEY);
  try {
    fill(saved ? JSON.parse(saved) : {});
  } catch {
    fill({});
  }

  // ----- run
  const formError = $('[data-form-error]');
  const show = (name) => {
    for (const k of ['idle', 'progress', 'result', 'failed']) $(`[data-${k}]`).hidden = k !== name;
  };

  function missing(brief) {
    const need = [];
    if (!brief.business) need.push('business');
    if (!brief.site) need.push('site');
    if (!brief.page?.service && !brief.page?.topic && !brief.page?.primary) need.push('page.subject');
    if (brief.page?.type === 'location' && !brief.page?.place) need.push('page.place');
    return need;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (running) return;
    const brief = sync();
    const need = missing(brief);
    formError.hidden = true;
    if (need.length) {
      need.forEach((n) => form.elements.namedItem(n)?.setAttribute('aria-invalid', 'true'));
      form.elements.namedItem(need[0])?.focus();
      formError.textContent = 'Fill in the fields marked required.';
      formError.hidden = false;
      return;
    }
    const token = form.elements.namedItem('token').value.trim();
    if (server?.token && !token) {
      formError.textContent = 'This writer needs its token.';
      formError.hidden = false;
      form.elements.namedItem('token').focus();
      return;
    }
    if (token) store.set('sessionStorage', TOKEN_KEY, token);
    await run(brief, token);
  });

  $('[data-cancel]').addEventListener('click', () => running?.abort());

  async function run(brief, token) {
    const controller = new AbortController();
    running = controller;
    const submit = $('[data-submit]');
    submit.disabled = true;
    submit.textContent = 'Writing…';
    show('progress');
    // On a phone the output sits under the form, out of sight.
    if (window.matchMedia('(max-width: 62rem)').matches) $('[data-out]').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('[data-progress-h]').textContent = 'Writing the page';
    const steps = $('[data-steps]');
    steps.replaceChildren();
    const started = Date.now();
    const tick = setInterval(() => ($('[data-clock]').textContent = clock(Date.now() - started)), 500);
    let current = null;
    const step = (name) => {
      if (current) {
        current.el.dataset.state = 'done';
        current.el.querySelector('.t').textContent = clock(Date.now() - current.at);
      }
      const [key, round] = name.split(' ');
      const [title, sub] = STEPS[key] || [name, ''];
      const li = document.createElement('li');
      li.dataset.state = 'now';
      li.innerHTML = `<span class="dot"></span><span class="what"><b>${escapeHtml(title)}</b><span>${escapeHtml(round ? `${sub} ${round}` : sub)}</span></span><span class="t"></span>`;
      steps.append(li);
      current = { el: li, at: Date.now() };
    };

    let code = 0;
    let data = null;
    try {
      const res = await fetch(`${endpoint}/api/write`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/x-ndjson', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ brief, live: form.elements.namedItem('live').checked }),
        signal: controller.signal,
      });
      if (!(res.headers.get('content-type') || '').includes('ndjson')) {
        code = res.status;
        data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      } else {
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += value;
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            const ev = JSON.parse(line);
            if (ev.type === 'step') step(ev.step);
            if (ev.type === 'done') ({ code, data } = ev);
          }
        }
        if (!data) throw new Error('The connection closed before the writer finished.');
      }
    } catch (err) {
      code = controller.signal.aborted ? 499 : 0;
      data = { error: controller.signal.aborted ? 'You stopped the run. No more model calls were made after this point.' : err.message };
    } finally {
      clearInterval(tick);
      running = null;
      submit.disabled = false;
      submit.textContent = 'Write the page';
    }
    if (current) current.el.dataset.state = code === 200 ? 'done' : 'stopped';
    if (code === 200) showResult(data, Date.now() - started);
    else showFailure(code, data);
  }

  // ----- results
  function showFailure(code, data) {
    show('failed');
    const titles = {
      0: 'Could not reach the writer',
      400: 'The brief needs a fix',
      401: 'The token was refused',
      402: 'Stopped at the spend cap',
      413: 'The brief is too big',
      499: 'Run stopped',
      502: 'The Claude API call failed',
      503: 'The writer is not set up',
    };
    const spent = data?.usage ? `<p>Spent so far: ${money(data.usage.cost)} over ${data.usage.calls} call${data.usage.calls === 1 ? '' : 's'}.</p>` : '';
    $('[data-failed]').innerHTML = `<h3>${escapeHtml(titles[code] || `The writer failed (${code})`)}</h3><p>${escapeHtml(data?.error || 'No reason given.')}</p>${spent}`;
  }

  function showResult(data, ms) {
    show('result');
    lastDoc = data;
    const doc = data.copyDoc || '';
    const fm = frontmatter(doc);
    const md = pageCopy(doc);
    const verdicts = {
      green: ['green', 'check.py is green', 'Ready to paste. Answer the owner questions first.'],
      red: ['red', 'check.py still has FAILs', 'Do not paste this one. The check report lists what is left.'],
      needs_decision: ['wait', 'Stopped at the plan', 'The site may already own this search. The copy doc says why.'],
    };
    const [cls, head, sub] = verdicts[data.status] || ['red', data.status, ''];
    $('[data-verdict]').innerHTML = `<span class="badge ${cls}">${escapeHtml(data.status)}</span>${data.demo ? '<span class="badge demo">demo output</span>' : ''}<h3>${escapeHtml(head)}</h3><p>${escapeHtml(sub)}</p>`;

    const u = data.usage || {};
    const cells = [
      ['Words', md ? wordCount(md).toLocaleString() : '–'],
      [data.demo ? 'Cost (sample)' : 'Cost', money(u.cost)],
      ['Model calls', u.calls ?? '–'],
      ['Time', clock(ms)],
    ];
    $('[data-meta]').innerHTML = cells.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join('');

    const confirms = data.confirms || [];
    $('[data-confirms]').hidden = !confirms.length;
    $('[data-confirm-list]').innerHTML = confirms.map((c) => `<li>${escapeHtml(c)}</li>`).join('');

    const host = (fm.site || '').replace(/^https?:\/\//, '');
    $('[data-serp]').innerHTML = fm.title
      ? `<div class="u">${escapeHtml(host)}${escapeHtml(fm.slug || '')}</div><p class="h">${escapeHtml(fm.title)}</p><p class="d">${escapeHtml(fm.meta || '')}</p>`
      : '';
    $('[data-serp]').hidden = !fm.title;
    $('[data-copy]').innerHTML = md ? renderMarkdown(md) : '<p>No page copy in this run. See the copy doc.</p>';
    $('[data-doc]').textContent = doc;

    const rows = reportRows(data.report);
    $('[data-report]').innerHTML = rows.length
      ? rows.map((r) => `<tr><td class="lv ${r.level}">${r.level}</td><td>${escapeHtml(r.area)}</td><td>${escapeHtml(r.text)}</td></tr>`).join('')
      : '<tr><td>No check report for this run.</td></tr>';

    $('[data-usage]').innerHTML = usageTable(data.usageTable);
    selectTab('preview');
  }

  function usageTable(mdTable) {
    const rows = String(mdTable || '')
      .split('\n')
      .filter((l) => l.startsWith('|') && !/^\|\s*-/.test(l))
      .map((l) => l.slice(1, -1).split('|').map((c) => c.trim().replace(/\*\*/g, '')));
    if (rows.length < 2) return '<tr><td>No usage recorded.</td></tr>';
    const [head, ...body] = rows;
    return `<thead><tr>${head.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${body
      .map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`)
      .join('')}</tbody>`;
  }

  const tabs = root.querySelectorAll('[data-tab]');
  function selectTab(name) {
    tabs.forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
    root.querySelectorAll('[data-pane]').forEach((p) => (p.hidden = p.dataset.pane !== name));
  }
  tabs.forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));

  const docNote = $('[data-doc-note]');
  $('[data-copy-doc]').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(lastDoc?.copyDoc || '');
      docNote.textContent = 'Copied.';
    } catch {
      docNote.textContent = 'Copy failed. Use the download.';
    }
  });
  $('[data-download-doc]').addEventListener('click', () => save(lastDoc?.copyDoc || '', lastDoc?.name || 'copy.md', 'text/markdown'));
}

function save(text, name, type) {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
