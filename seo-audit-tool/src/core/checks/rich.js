// Social tags, structured data and hreflang.
import { issue, pass } from '../findings.js';
import { clip, listSample } from '../util.js';

export function checkSocial(ctx, r) {
  const { page } = ctx;
  const C = 'social';
  const missingOg = ['title', 'description', 'image', 'url'].filter((k) => !page.og[k]);
  if (missingOg.length === 4) {
    r.add(
      issue('og-missing', C, 'medium', {
        issue: 'No Open Graph tags',
        impact: 'Links shared on social apps and messaging show a bare URL or a random image instead of a proper preview.',
        evidence: 'No og:title, og:description, og:image or og:url found.',
        fix: 'Add og:title, og:description, og:image (1200 by 630) and og:url.',
      }),
    );
  } else if (missingOg.length) {
    r.add(
      issue('og-incomplete', C, missingOg.includes('image') ? 'medium' : 'low', {
        issue: `Open Graph tags are incomplete`,
        impact: 'Share previews will be missing pieces, especially without an image.',
        evidence: `Missing: ${missingOg.map((k) => `og:${k}`).join(', ')}.`,
        fix: 'Fill in the missing Open Graph tags.',
      }),
    );
  } else {
    r.add(pass('og-complete', C, 'Open Graph tags are complete'));
  }
  if (page.og.image && !/^https?:\/\//i.test(page.og.image)) {
    r.add(
      issue('og-image-relative', C, 'low', {
        issue: 'og:image is not an absolute URL',
        impact: 'Most share previews ignore relative image paths.',
        evidence: clip(page.og.image),
        fix: 'Use a full https URL for og:image.',
      }),
    );
  }
  if (!page.twitter.card) {
    r.add(
      issue('twitter-card-missing', C, 'low', {
        issue: 'No twitter:card tag',
        impact: 'Shares on X fall back to a small preview.',
        evidence: 'No <meta name="twitter:card"> found.',
        fix: 'Add <meta name="twitter:card" content="summary_large_image">.',
      }),
    );
  } else {
    r.add(pass('twitter-card', C, `twitter:card is set (${page.twitter.card})`));
  }
}

// Types that count as a local business for the required-fields check.
const LOCAL_TYPES = new Set(
  [
    'LocalBusiness', 'AutoRepair', 'AutomotiveBusiness', 'AutoBodyShop', 'AutoDealer', 'Plumber', 'RoofingContractor',
    'HousePainter', 'Electrician', 'HVACBusiness', 'GeneralContractor', 'HomeAndConstructionBusiness', 'Locksmith',
    'MovingCompany', 'ProfessionalService', 'FinancialService', 'AccountingService', 'InsuranceAgency', 'LegalService',
    'Attorney', 'RealEstateAgent', 'Dentist', 'MedicalBusiness', 'Physician', 'Restaurant', 'FoodEstablishment',
    'Store', 'HealthAndBeautyBusiness', 'DaySpa', 'BeautySalon', 'HairSalon', 'ChildCare', 'EmploymentAgency',
    'EntertainmentBusiness', 'SportsActivityLocation', 'LodgingBusiness', 'Hotel', 'TravelAgency', 'DryCleaningOrLaundry',
    'EmergencyService', 'GovernmentOffice', 'Library', 'SelfStorage', 'ShoppingCenter', 'TouristInformationCenter',
    'RecyclingCenter', 'AnimalShelter', 'ArchiveOrganization', 'RadioStation', 'TelevisionStation', 'InternetCafe',
  ].map((t) => t.toLowerCase()),
);

export function flattenSchema(blocks) {
  const nodes = [];
  const visit = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(visit);
    if (n['@type']) nodes.push(n);
    if (Array.isArray(n['@graph'])) n['@graph'].forEach(visit);
  };
  for (const b of blocks) if (b.ok) visit(b.data);
  return nodes;
}

export function typesOf(node) {
  const t = node['@type'];
  return (Array.isArray(t) ? t : [t]).filter((x) => typeof x === 'string');
}

export function isLocalNode(node) {
  return typesOf(node).some((t) => LOCAL_TYPES.has(t.toLowerCase()));
}

export function checkSchema(ctx, r) {
  const { page } = ctx;
  const C = 'schema';
  const bad = page.jsonld.filter((b) => !b.ok);
  if (bad.length) {
    r.add(
      issue('schema-invalid-json', C, 'high', {
        issue: `${bad.length} structured data block(s) are not valid JSON`,
        impact: 'Search engines skip the whole block, so none of that markup counts.',
        evidence: listSample(bad.map((b) => b.error)),
        fix: 'Fix the JSON syntax (often a trailing comma or an unescaped quote).',
      }),
    );
  }
  const nodes = flattenSchema(page.jsonld);
  const types = [...new Set(nodes.flatMap(typesOf))];
  if (nodes.length === 0 && page.microdataTypes.length === 0) {
    r.add(
      issue('schema-missing', C, 'medium', {
        issue: 'No structured data found',
        impact: 'Structured data helps search engines and AI answers understand the business and can earn rich results.',
        evidence: 'No JSON-LD or microdata on the page.',
        fix: 'Add JSON-LD for the business (LocalBusiness or a more specific type), plus WebSite and BreadcrumbList.',
      }),
    );
    return;
  }
  r.add(pass('schema-present', C, `Structured data found: ${listSample(types.length ? types : page.microdataTypes, 8)}`));

  for (const block of page.jsonld.filter((b) => b.ok)) {
    const ctxVal = JSON.stringify(block.data['@context'] ?? (Array.isArray(block.data) ? block.data[0]?.['@context'] : ''));
    if (!/schema\.org/i.test(ctxVal || '')) {
      r.add(
        issue('schema-context', C, 'low', {
          issue: 'A JSON-LD block has no schema.org @context',
          impact: 'Without the context, the markup may not be read as schema.org vocabulary.',
          evidence: clip(JSON.stringify(block.data), 140),
          fix: 'Add "@context": "https://schema.org" to the top of the block.',
        }),
      );
      break;
    }
  }

  for (const node of nodes.filter(isLocalNode)) {
    const missing = [];
    if (!node.name) missing.push('name');
    if (!node.address) missing.push('address');
    if (!node.telephone) missing.push('telephone');
    if (!node.url) missing.push('url');
    if (!node.openingHoursSpecification && !node.openingHours) missing.push('opening hours');
    if (!node.geo) missing.push('geo');
    if (!node.image && !node.logo) missing.push('image');
    const critical = missing.filter((m) => ['name', 'address', 'telephone'].includes(m));
    if (missing.length) {
      r.add(
        issue('schema-local-fields', C, critical.length ? 'medium' : 'low', {
          issue: `${typesOf(node)[0]} markup is missing fields`,
          impact: 'Complete business markup is a strong signal for local results and keeps details consistent across search.',
          evidence: `Missing: ${missing.join(', ')}.`,
          fix: 'Fill in the missing properties with the exact name, address and phone used on your business profile.',
        }),
      );
    } else {
      r.add(pass('schema-local-complete', C, `${typesOf(node)[0]} markup has the key fields`));
    }
    if (node.address && typeof node.address === 'object') {
      const a = Array.isArray(node.address) ? node.address[0] : node.address;
      const miss = ['streetAddress', 'addressLocality', 'addressRegion', 'postalCode'].filter((k) => !a?.[k]);
      if (miss.length) {
        r.add(
          issue('schema-address-parts', C, 'low', {
            issue: 'The business address markup is incomplete',
            impact: 'Partial addresses are harder to match to the business listing.',
            evidence: `PostalAddress is missing ${miss.join(', ')}.`,
            fix: 'Use a PostalAddress with street, city, state and ZIP.',
          }),
        );
      }
    }
  }
  for (const node of nodes.filter((n) => typesOf(n).includes('Organization'))) {
    if (!node.name || !node.url) {
      r.add(
        issue('schema-org-fields', C, 'low', {
          issue: 'Organization markup is missing name or url',
          impact: 'These two fields are what tie the markup to your brand.',
          evidence: `Missing: ${[!node.name && 'name', !node.url && 'url'].filter(Boolean).join(', ')}.`,
          fix: 'Add name and url (and logo and sameAs links to your profiles).',
        }),
      );
    }
  }
  for (const node of nodes.filter((n) => typesOf(n).includes('FAQPage'))) {
    const q = node.mainEntity;
    if (!Array.isArray(q) || q.length === 0) {
      r.add(
        issue('schema-faq-empty', C, 'low', {
          issue: 'FAQPage markup has no questions',
          impact: 'Empty FAQ markup is ignored.',
          evidence: 'mainEntity is missing or empty.',
          fix: 'List each Question with its acceptedAnswer, matching the visible FAQ text.',
        }),
      );
    }
  }
}

const HREFLANG = /^(x-default|[a-z]{2,3}(-[a-z]{4})?(-([a-z]{2}|\d{3}))?)$/i;

export function checkHreflang(ctx, r) {
  const { page, main } = ctx;
  if (page.hreflang.length === 0) return; // only relevant for multi-language sites
  const C = 'indexing';
  const invalid = page.hreflang.filter((h) => !HREFLANG.test(h.lang));
  if (invalid.length) {
    r.add(
      issue('hreflang-invalid', C, 'medium', {
        issue: 'Invalid hreflang codes',
        impact: 'Search engines ignore hreflang tags with codes they do not recognise.',
        evidence: listSample(invalid.map((h) => h.lang || '(empty)')),
        fix: 'Use ISO language codes with optional region, like en, en-US or es-MX, plus x-default.',
      }),
    );
  }
  const relative = page.hreflang.filter((h) => !/^https?:\/\//i.test(h.href));
  if (relative.length) {
    r.add(
      issue('hreflang-relative', C, 'low', {
        issue: 'hreflang links use relative URLs',
        impact: 'hreflang URLs must be absolute to be trusted.',
        evidence: listSample(relative.map((h) => h.href)),
        fix: 'Use full https URLs in every hreflang link.',
      }),
    );
  }
  const self = page.hreflang.some((h) => h.abs && h.abs.replace(/\/$/, '') === main.url.replace(/\/$/, ''));
  if (!self) {
    r.add(
      issue('hreflang-no-self', C, 'low', {
        issue: 'hreflang set does not include this page',
        impact: 'Each page in a language set should list itself, or the set may be ignored.',
        evidence: `${page.hreflang.length} hreflang links, none pointing at ${clip(main.url)}.`,
        fix: 'Add a self-referencing hreflang link.',
      }),
    );
  }
  if (!page.hreflang.some((h) => h.lang.toLowerCase() === 'x-default')) {
    r.add(
      issue('hreflang-no-default', C, 'low', {
        issue: 'No x-default hreflang',
        impact: 'Visitors whose language is not listed get no clear fallback page.',
        evidence: listSample(page.hreflang.map((h) => h.lang)),
        fix: 'Add hreflang="x-default" pointing at the main version.',
      }),
    );
  }
  if (!invalid.length && !relative.length && self) r.add(pass('hreflang-ok', C, 'hreflang tags look valid'));
}
