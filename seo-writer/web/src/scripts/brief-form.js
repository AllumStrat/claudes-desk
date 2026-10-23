// The form and the brief JSON, both ways. The form holds the fields a person
// fills in most; anything else in a pasted brief is kept as it was.

const lines = (s) =>
  String(s || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
const pipe = (l) => l.split('|').map((x) => x.trim());
const val = (form, name) => form.elements.namedItem(name)?.value?.trim() ?? '';
const set = (form, name, v) => {
  const el = form.elements.namedItem(name);
  if (el) el.value = v ?? '';
};
const drop = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v != null && !(Array.isArray(v) && !v.length)));

/** Reads the form into a brief. extra is a pasted brief whose other fields are kept. */
export function formToBrief(form, extra = {}) {
  const type = form.elements.namedItem('page.type').value;
  const subject = val(form, 'page.subject');
  const words = val(form, 'page.words_target');
  const facts = [...form.querySelectorAll('[data-fact]')]
    .map((row) => ({ fact: row.querySelector('[name=fact]').value.trim(), source: row.querySelector('[name=fact_source]').value.trim() }))
    .filter((f) => f.fact);
  const keywords = drop({
    ...(extra.keywords || {}),
    primary: val(form, 'page.primary'),
    variants: lines(val(form, 'keywords.variants')),
    secondary: lines(val(form, 'keywords.secondary')),
  });
  return drop({
    ...extra,
    client: val(form, 'client'),
    business: val(form, 'business'),
    brand: val(form, 'brand'),
    site: val(form, 'site'),
    page: drop({
      ...(extra.page || {}),
      type,
      service: type === 'blog' ? '' : subject,
      topic: type === 'blog' ? subject : '',
      place: type === 'location' ? val(form, 'page.place') : '',
      primary: val(form, 'page.primary'),
      slug: val(form, 'page.slug'),
      words_target: words ? Number(words) : null,
      notes: val(form, 'page.notes'),
    }),
    facts,
    voice_of_customer: lines(val(form, 'voice_of_customer')),
    conversion: drop({ action: val(form, 'conversion.action'), url: val(form, 'conversion.url') }),
    internal_pages: lines(val(form, 'internal_pages')).map((l) => {
      const [url, title] = pipe(l);
      return title ? { url, title } : { url };
    }),
    external_sources: lines(val(form, 'external_sources')).map((l) => {
      const [url, quote] = pipe(l);
      return quote ? { url, quote } : { url };
    }),
    keywords,
    competitors: lines(val(form, 'competitors')),
    retired_names: lines(val(form, 'retired_names')),
    // Siblings pasted as Markdown have no form field; they ride along in extra.
    siblings: [...lines(val(form, 'siblings')).map((url) => ({ name: url, url })), ...(extra.siblings || [])],
    sitemap: form.elements.namedItem('sitemap').checked || undefined,
  });
}

/** Fills the form from a brief. Returns the brief, to keep as the form's extra fields. */
export function briefToForm(form, brief) {
  const page = brief.page || {};
  for (const k of ['client', 'business', 'brand', 'site']) set(form, k, brief[k]);
  const type = ['service', 'location', 'blog'].includes(page.type) ? page.type : 'service';
  form.querySelector(`[name="page.type"][value="${type}"]`).checked = true;
  set(form, 'page.subject', page.service || page.topic || '');
  set(form, 'page.place', page.place);
  set(form, 'page.primary', page.primary || brief.keywords?.primary || '');
  set(form, 'page.slug', page.slug);
  set(form, 'page.words_target', page.words_target ?? '');
  set(form, 'page.notes', page.notes);
  set(form, 'voice_of_customer', (brief.voice_of_customer || []).join('\n'));
  set(form, 'conversion.action', brief.conversion?.action);
  set(form, 'conversion.url', brief.conversion?.url);
  const asList = (xs, fn) => (Array.isArray(xs) ? xs : []).map(fn).join('\n');
  set(form, 'internal_pages', asList(brief.internal_pages, (p) => (typeof p === 'string' ? p : p.title ? `${p.url} | ${p.title}` : p.url)));
  set(form, 'external_sources', asList(brief.external_sources, (s) => (typeof s === 'string' ? s : s.quote ? `${s.url} | ${s.quote}` : s.url)));
  set(form, 'keywords.variants', (brief.keywords?.variants || []).join('\n'));
  set(form, 'keywords.secondary', (brief.keywords?.secondary || []).join('\n'));
  set(form, 'competitors', (brief.competitors || []).join('\n'));
  set(form, 'retired_names', (brief.retired_names || []).join('\n'));
  set(form, 'siblings', asList((brief.siblings || []).filter((s) => typeof s === 'string' || !s.markdown), (s) => (typeof s === 'string' ? s : s.url || '')));
  form.elements.namedItem('sitemap').checked = brief.sitemap === true;

  const list = form.querySelector('[data-facts]');
  list.replaceChildren();
  const facts = (brief.facts || []).map((f) => (typeof f === 'string' ? { fact: f, source: '' } : f));
  for (const f of facts.length ? facts : [{}]) addFact(form, f);
  form.dispatchEvent(new Event('input', { bubbles: true }));
  return brief;
}

export function addFact(form, f = {}) {
  const tpl = form.querySelector('[data-fact-template]');
  const row = tpl.content.firstElementChild.cloneNode(true);
  row.querySelector('[name=fact]').value = f.fact || '';
  row.querySelector('[name=fact_source]').value = f.source || '';
  form.querySelector('[data-facts]').append(row);
  return row;
}

/** The parts of a pasted brief the form has no field for, so they survive a round trip. */
export function extraFields(brief) {
  const { page = {}, keywords = {}, siblings = [], ...rest } = brief || {};
  const known = ['client', 'business', 'brand', 'site', 'facts', 'voice_of_customer', 'conversion', 'internal_pages', 'external_sources', 'competitors', 'retired_names', 'siblings', 'sitemap'];
  for (const k of known) delete rest[k];
  const { type, service, topic, place, primary, slug, words_target, notes, ...pageRest } = page;
  const { primary: kp, variants, secondary, ...kwRest } = keywords;
  const pasted = (Array.isArray(siblings) ? siblings : []).filter((s) => s && typeof s === 'object' && s.markdown);
  return { ...rest, page: pageRest, keywords: kwRest, ...(pasted.length ? { siblings: pasted } : {}) };
}
