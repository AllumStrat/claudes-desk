// Name, address and phone (NAP) signals for local businesses.
import { issue, pass } from '../findings.js';
import { flattenSchema, isLocalNode } from './rich.js';
import { listSample } from '../util.js';

const PHONE = /(?:\+?1[\s.-]?)?\(?([2-9]\d{2})\)?[\s.-]?([2-9]\d{2})[\s.-]?(\d{4})(?!\d)/g;
const STREET = '(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Ct|Court|Pkwy|Parkway|Hwy|Highway|Pl|Place|Cir|Circle|Trl|Trail|Ter|Terrace|Loop|Sq|Square)';
const ADDRESS = new RegExp(
  `\\b\\d{1,6}\\s+(?:[NSEW]\\.?\\s+)?[A-Za-z0-9.'\\- ]{2,40}?\\s${STREET}\\b\\.?,?[^\\d]{0,60}?\\b([A-Z]{2})\\s+(\\d{5})(?:-\\d{4})?\\b`,
  'g',
);

export function findPhones(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(PHONE)) out.add(`${m[1]}${m[2]}${m[3]}`);
  return [...out];
}

export function findAddresses(text) {
  return [...String(text || '').matchAll(ADDRESS)].map((m) => ({ text: m[0].trim(), state: m[1], zip: m[2] }));
}

const digits = (s) => String(s || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
const fmt = (d) => (d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : d);

export function checkLocal(ctx, r) {
  const { page } = ctx;
  const C = 'local';
  const nodes = flattenSchema(page.jsonld).filter(isLocalNode);
  const textPhones = findPhones(page.bodyText);
  const telPhones = page.telLinks.map(digits).filter((d) => d.length === 10);
  const addresses = findAddresses(page.bodyText);
  const schemaPhones = nodes.map((n) => digits(n.telephone)).filter(Boolean);

  const looksLocal = nodes.length > 0 || telPhones.length > 0 || (textPhones.length > 0 && addresses.length > 0);
  ctx.localSignals = { nodes: nodes.length, phones: textPhones.length, addresses: addresses.length, looksLocal };
  if (!looksLocal) {
    r.insight(C, 'Local signals', 'No local business details found, so local checks were skipped.');
    return;
  }

  if (textPhones.length || telPhones.length) {
    r.add(pass('nap-phone', C, `Phone number shown: ${fmt(textPhones[0] || telPhones[0])}`));
  } else {
    r.add(
      issue('nap-phone-missing', C, 'medium', {
        issue: 'No phone number visible on the page',
        impact: 'Local searchers want to call. A visible number also confirms the business details search engines hold.',
        evidence: 'No phone number pattern in the visible text.',
        fix: 'Show the main business phone in the header or footer, matching your business profile exactly.',
      }),
    );
  }
  if (textPhones.length && telPhones.length === 0) {
    r.add(
      issue('nap-no-tel-link', C, 'low', {
        issue: 'The phone number is not clickable',
        impact: 'Mobile visitors have to copy the number by hand, which loses calls.',
        evidence: `Number ${fmt(textPhones[0])} has no tel: link.`,
        fix: `Wrap it in <a href="tel:+1${textPhones[0]}">.`,
      }),
    );
  }
  if (addresses.length) {
    r.add(pass('nap-address', C, `Address shown: ${addresses[0].text.slice(0, 80)}`));
  } else {
    r.add(
      issue('nap-address-missing', C, 'low', {
        issue: 'No street address found in the page text',
        impact: 'A visible address supports local rankings, unless you are a service-area business that hides it on purpose.',
        evidence: 'No street address pattern found in the visible text.',
        fix: 'Show the full address in the footer (or the city and service area if you hide your address).',
      }),
    );
  }
  if (nodes.length === 0) {
    r.add(
      issue('nap-no-schema', C, 'medium', {
        issue: 'No LocalBusiness structured data',
        impact: 'Business markup ties the page to your business profile and helps local and AI search results.',
        evidence: 'The page shows business contact details but has no LocalBusiness-type JSON-LD.',
        fix: 'Add LocalBusiness JSON-LD (or a specific type like AutoRepair or Plumber) with name, address, phone, hours and geo.',
      }),
    );
  }
  const shown = new Set([...textPhones, ...telPhones]);
  const mismatched = schemaPhones.filter((p) => p.length === 10 && shown.size && !shown.has(p));
  if (mismatched.length) {
    r.add(
      issue('nap-phone-mismatch', C, 'medium', {
        issue: 'The phone in the markup does not match the phone on the page',
        impact: 'Inconsistent business details weaken trust in your listing data.',
        evidence: `Markup: ${listSample(mismatched.map(fmt))}. Page: ${listSample([...shown].map(fmt))}.`,
        fix: 'Use one phone number everywhere: page, markup and business profile.',
      }),
    );
  } else if (schemaPhones.length && shown.size) {
    r.add(pass('nap-phone-consistent', C, 'Phone in markup matches the page'));
  }
  const zips = nodes
    .map((n) => (Array.isArray(n.address) ? n.address[0] : n.address))
    .map((a) => (a && typeof a === 'object' ? String(a.postalCode || '').slice(0, 5) : ''))
    .filter(Boolean);
  if (zips.length && addresses.length && !zips.some((z) => addresses.some((a) => a.zip === z))) {
    r.add(
      issue('nap-zip-mismatch', C, 'low', {
        issue: 'The ZIP code in the markup differs from the address on the page',
        impact: 'Address mismatches make it harder to tie the page to one business location.',
        evidence: `Markup ZIP ${zips[0]}, page ZIP ${addresses[0].zip}.`,
        fix: 'Make the markup address match the visible address exactly.',
      }),
    );
  }
}
