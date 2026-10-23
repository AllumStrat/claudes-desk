// Demo mode: the full pipeline with a canned model and a canned network, so
// the web page can be shown without an API key, a token or any spend. Every
// run writes the same fictional page (Example Auto, brake repair in
// Norterra) whatever brief is sent, and the answer is marked demo: true.
// Nothing here makes a request.

const NHTSA = 'https://www.nhtsa.gov/equipment/brakes';
const NHTSA_QUOTE = 'Brakes are one of the most important safety features';

export const DEMO_BRIEF = {
  client: 'example-auto',
  business: 'Example Auto',
  site: 'example-auto.com',
  page: { type: 'location', service: 'brake repair', place: 'Norterra', words_target: 1000 },
  facts: [{ fact: 'Shop is on Happy Valley Road', source: 'owner' }, { fact: 'Free brake inspection', source: 'owner' }],
  voice_of_customer: ['my brakes squeal every morning'],
  conversion: { action: 'Book a brake inspection', url: '/contact/' },
  internal_pages: [{ url: '/service/brakes/', title: 'Brake repair' }, { url: '/deer-valley-auto-repair/', title: 'Deer Valley auto repair' }],
  competitors: ['rivalshop.com'],
};

const BODY = `# Brake repair in Norterra

Example Auto does brake repair in Norterra from our shop on Happy Valley Road, about four minutes from the I-17 interchange. Most brake jobs are done the same day, and every visit starts with a free inspection so you know what the car needs before we touch it.

## How close is the shop to Norterra?

The shop is 1.8 miles from the Norterra shopping center. Drivers coming from the west side of the neighborhood take Happy Valley Road east and turn into our lot just past the gas station. If you drop the car off in the morning, the Norterra library and the coffee shops on North Valley Parkway are a short walk away while you wait.

Our brake service in Norterra covers cars, light trucks and SUVs. We see a lot of commuter sedans and family crossovers from the neighborhood, plus work trucks that run up and down the I-17 every day.

## Why brakes wear faster here

Phoenix heat is hard on brakes. Pavement in July can pass 150 degrees, and pads that sit in that heat and then stop from freeway speed wear faster than the same pads in a mild climate. Brake fluid also takes on moisture over time, and old fluid boils sooner under heavy stops.

The commute matters too. A drive from Norterra to downtown means long stretches at 65 mph followed by hard braking at the Loop 101 and Dunlap exits. That pattern builds heat in the rotors, which is why warped rotors and a pulsing pedal are common complaints at our Norterra brake shop.

## Signs your car needs brake work

Bring the car in if you notice any of these:

- squealing brakes when you first pull out in the morning
- a grinding noise, which often means the pads are worn to the metal
- a pedal that pulses or shakes when you stop from highway speed
- the car pulling to one side under braking
- a soft pedal that sinks closer to the floor than it used to
- a brake warning light on the dash

Squealing brakes are not always an emergency. Some pads have a small metal tab that squeals on purpose when the pad gets thin. Grinding is different. If you hear grinding, plan your brake repair in Norterra soon, because metal on metal cuts into the rotor and turns a pad job into a rotor job.

## What a brake job at Example Auto includes

Every brake job starts with a road test and a full inspection. We measure pad thickness and rotor thickness, check the calipers and hoses, and test the brake fluid. You get the measurements and a written quote before any work starts.

1. Road test to feel for pulsing, pulling and noise
2. Wheel removal and measurement of pads and rotors
3. Caliper, hose and fluid check
4. Written quote with the measurements
5. Repair, then a second road test before we hand back the keys

Brake pad replacement is the most common job we do. Rotors get resurfaced or replaced when they are below the minimum thickness stamped on them, or when they are warped. If the fluid tests high for moisture, we recommend a flush.

## Brake inspection cost and what drives the price

The inspection is free. The brake inspection cost question people usually mean is what the repair will cost, and that depends on the parts the car needs. A pad-only job costs less than pads and rotors together, and trucks with larger rotors cost more than small sedans.

We quote each axle separately, so you can see where the money goes. [CONFIRM: does the owner want a starting price for front pads listed on the page?] Federal rules require brakes to meet a stopping standard, and [NHTSA's brake safety guidance](https://www.nhtsa.gov/equipment/brakes) explains why worn parts should be replaced before they fail.

## Other repairs near Norterra

Brakes are often found during other visits. If the inspection shows a leaking strut or a worn tire, we will tell you and let you decide. You can read more about our [brake repair service](/service/brakes/) for the full list of brake parts we replace, or see our [Deer Valley auto repair](/deer-valley-auto-repair/) page if you live south of the neighborhood.

For brake work near Norterra, the fastest way to get on the schedule is to [book a brake inspection](/contact/) online. Same-day appointments open most weekday mornings.

## Frequently asked questions

### How long does brake repair in Norterra take?

Most pad and rotor jobs take one to two hours. If parts need to be ordered, we will tell you when you drop the car off.

### Do you work on trucks and SUVs?

Yes. We work on light trucks and SUVs, including half-ton pickups and three-row crossovers.

### Is it safe to drive with squealing brakes?

Usually for a short time, since many pads squeal on purpose as they wear. Get them checked within a week or two, and stop driving if the noise turns to grinding.

### Do I need an appointment for a brake inspection?

No appointment is needed for an inspection, but booking ahead gets you the first open slot of the day.

### Do you replace brake fluid?

Yes. We test the fluid during every inspection and flush it when it shows too much moisture.

## Book your brake repair in Norterra

Call the shop or book online, and we will have the inspection results to you within the hour. Example Auto is on Happy Valley Road, a short drive from every street in Norterra.`;

const kw = (keyword, source = 'suggested, no search data') => ({ keyword, source });
const opt = (text, recommended = false) => ({ text, reason: 'fits', recommended });
const TITLE = 'Brake repair in Norterra | Example Auto';
const META = 'Brake repair in Norterra from Example Auto on Happy Valley Road. ASE-certified techs, free brake inspection and pads, rotors and fluid done the same day.';

const PLAN = {
  search: 'brake repair in Norterra',
  intent: 'local',
  subtype: 'location page for a service',
  ownership_line: 'No page on the site targets brake repair in Norterra.',
  proceed: true,
  stop_reason: '',
  slug: 'norterra-brake-repair',
  primary: kw('brake repair norterra', 'brief'),
  variants: [kw('brake service in norterra'), kw('norterra brake shop'), kw('brake work near norterra')],
  secondary: ['brake pad replacement', 'squealing brakes', 'brake inspection cost'].map((k) => ({ ...kw(k), shares_intent: true })),
  own_page_keywords: [],
  facts: [],
  confirm_questions: ['Starting price for front pads?'],
  voice_of_customer: [],
  conversion: { action: 'Book a brake inspection', url: '/contact/' },
  internal_links: [],
  external_candidates: [{ url: NHTSA, claim: 'worn brakes should be replaced', quote: NHTSA_QUOTE, source_rank: 1 }],
  outline: [],
};

const OPTIONS = {
  title_options: [opt(TITLE, true), opt('Norterra brake repair | Example Auto')],
  subhead_options: [opt('Same-day brakes near I-17', true)],
  cta_options: [opt('Book a free brake inspection', true)],
};

const ANSWERS = {
  plan: PLAN,
  draft: { body: BODY, meta: META, ...OPTIONS, inbound_edits: [{ page: '/service/brakes/', sentence: 'We also do brake repair in Norterra.', anchor: 'brake repair in Norterra' }] },
  edit: { body: BODY, title: TITLE, meta: META, ...OPTIONS, fixes: ['Cut "nestled" from the intro'], eeat: [{ signal: 'Location and contact', status: 'present', where: 'intro' }] },
  fix: { body: BODY, title: '', meta: '', changes: [], warn_notes: [] },
  sources: { candidates: [] },
};

/** A canned model with roughly real token counts, paced so progress shows. */
export function createDemoLlm({ delayMs = 900 } = {}) {
  let n = 0;
  return {
    async call(req) {
      const key = Object.keys(ANSWERS).find((k) => req.step === k || req.step.startsWith(k + ' '));
      if (!key) throw new Error(`demo has no answer for ${req.step}`);
      await pause(delayMs, req.signal);
      const first = n++ === 0;
      const usage = { input_tokens: 1200, cache_creation_input_tokens: first ? 13000 : 0, cache_read_input_tokens: first ? 0 : 14000, output_tokens: 5000 };
      return { data: structuredClone(ANSWERS[key]), usage, model: 'claude-sonnet-5-5' };
    },
  };
}

/** A canned network: the one source page loads, everything else is a 404. */
export function createDemoNet() {
  const page = { status: 200, url: NHTSA, body: `<html><body><main><p>${NHTSA_QUOTE} on your vehicle.</p></main></body></html>` };
  return {
    async fetchPage(url) {
      return url === NHTSA ? page : { status: 404, url, body: '' };
    },
    async status(url) {
      return [url === NHTSA ? 200 : 404, null];
    },
  };
}

function pause(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });
}
