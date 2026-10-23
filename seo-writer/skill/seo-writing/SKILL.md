---
name: seo-writing
description: SEO writing for pages that need to rank on Google and get cited in AI answers. Use when Jacob asks to write or rewrite a blog post, guide, service page or location page for a target keyword, or to build out a set of pages from one pattern. Also writes the coding-agent handoff when the page will be built. Other skills reach for it for length, metadata and linking rules.
---

# SEO writing

Every run produces one **copy doc**: the page's words, metadata, link plan and a check report. The copy doc says what the page contains. Layout, hero, buttons, images, fonts and colors belong to the separate UI agent, so the copy doc stays silent on them.

## Sources of truth

| Source | Owns | When |
|---|---|---|
| [PARAMETERS.md](PARAMETERS.md) | Every number and rule: content requirements, length, keywords, metadata, links, overlap, SERP exclusions | Steps 2 to 5 and 8. Change the skill's behavior here. |
| copywriting skill | Persuasion: clarity, benefits, customer language, headline and CTA options | Step 6 |
| anti-ai-writing skill | Voice: banned vocabulary and core rules | Step 7 |
| seo-audit skill | Its "Content Quality Assessment" section (E-E-A-T) | Steps 3 and 8. PARAMETERS.md replaces its numeric limits. |
| programmatic-seo skill | Batch branch | [BATCH.md](BATCH.md) |
| [HANDOFF.md](HANDOFF.md) | The coding-agent handoff | Step 9, when a coding agent will build the page |
| [scripts/serp.py](scripts/serp.py) | Measures the top 3 results | Step 3 |
| [scripts/check.py](scripts/check.py) | Mechanical checks on the draft | Step 8. The draft is **green** when the report shows zero FAIL. |

When sources disagree, this order wins: confirmed facts, then PARAMETERS.md, then anti-ai-writing, then copywriting.

## Branches

- **New page** (default): steps 1 to 9.
- **Rewrite**: keep the URL. Keep the primary keyword unless the search data says it is wrong, and flag it if so. Step 1 adds the current page text and the queries it ranks for. The copy doc lists what changed and why.
- **Batch** (three or more pages from one pattern, such as "[service] in [city]"): read [BATCH.md](BATCH.md) before step 1.

## Step 1: Pick the search

Decide the one search this page exists to win: the words a real customer types when they need what the page offers.

- **Search**: the query, from Search Console data, Jacob's notes, or the obvious customer phrasing of the service and place.
- **Intent**: informational (learning), commercial (comparing), transactional (ready to hire) or local (near me, in a place). The intent decides the page type.
- **Page type**: service, location or blog, plus the subtype from the page types table in PARAMETERS.md (neighborhood, city, specific job, brand, hub, guide). The subtype decides what the page owns.
- **SERP fit**: search the query and look at what Google ranks. If page one is mostly aggregators, directories or forums, or the ranking pages are a different type than planned, stop and tell Jacob before writing; the search may be the wrong one.
- **Ownership**: pull the sitemap and list every page on the site that targets the same search. If one already owns it, stop and tell Jacob; the job may be a rewrite. Otherwise write the ownership line: the one question this page answers that no other page on the site answers.

Done when the search, intent, page type, SERP fit and ownership line are written at the top of the copy doc.

## Step 2: Choose the keywords

- **Primary keyword**: the search from step 1, in the form people type it. Its placement, spread and density follow the `keywords` rules in PARAMETERS.md.
- **Variants**: two to four synonyms or close variants of the primary, so the page covers the topic without repeating one phrase.
- **Secondary keywords**: two to five related searches that belong on the same page. Pull them from SearchAtlas `se_lookup_keyword` (volume, difficulty, intent and related keywords; pass a `location_id` for city searches), Google's People Also Ask, related searches, autocomplete and Search Console. A secondary keyword with its own distinct intent belongs on its own page; list it for Jacob instead.
- Add impressions and position for each from Search Console when Jacob has them. This is the 30-day baseline.

Done when the primary, every variant and every secondary keyword are written with their source, and each secondary is confirmed to share the primary's intent.

## Step 3: Study the top 3

The goal is a plan to **dethrone** the three pages Google ranks highest for the primary keyword.

1. Pull the SERP from the most faithful source available:
   - **Local intent**: run the Google search in Claude in Chrome with the place in the query, since local results shift by location. Without Chrome, use the SearchAtlas SERP overview with the place in the keyword.
   - **Everything else**: SearchAtlas SERP overview (`se_research_keywords` to save the keyword, then `se_keyword_research_projects` with `mode=serp`).
   - **Fallback**: web search, noted in the copy doc as the source.

   Take the top three organic results, skipping every domain in `serp_exclude` in PARAMETERS.md (Reddit, social media, Yelp, Trustpilot and other aggregators) and any result that is a different page type.
2. Run `python3 scripts/serp.py URL1 URL2 URL3`. It measures each page against the content requirements and prints the length target. When it skips a page it can't fetch, open that page in Claude in Chrome, read the text with `get_page_text`, count words, H2s and lists by hand, and add the row. Without Chrome, take the next organic result instead. Either way, the target rests on three pages.
3. Read each page in full and write a **teardown** for each: what it covers (its H2 subtopics), what it gets wrong or leaves out, how specific it is (numbers, named parts, places, prices, proof), its freshness, and its E-E-A-T signals from seo-audit's "Content Quality Assessment" section.
4. Write the **dethrone plan**:
   - every subtopic two or more of the three cover (the price of entry)
   - one to three subtopics none of them cover well, drawn from confirmed facts (the reason to rank this page over them)
   - where this page will beat them on specifics and proof
   - secondary keywords the competitors' headings surfaced, added to step 2's list if they share its intent
   - the length target from serp.py

Done when all three teardowns are written, the dethrone plan holds every two-of-three subtopic and at least one subtopic the three miss, and the length target is a written number.

## Step 4: Gather facts and links

- **Confirmed facts**, each with its source (client brief, About page, owner's written answers, job notes, reviews). Anything without a source gets an inline `[CONFIRM: question for the owner]`.
- **Voice of customer**: real wording from reviews, job notes and customer questions.
- **Conversion action**: the one thing a reader should do.
- **Internal link targets** from the sitemap, per the page type's required targets in PARAMETERS.md, each confirmed to return 200.
- **External sources** for the claims that need support, in the source order in PARAMETERS.md.

Claim rules:

- **Accuracy beats selling.** If work is sent out (a rebuild going to an outside builder, a part machined elsewhere), say so plainly. Never imply in-house work that isn't.
- **Written sign-off first** for prices, warranties, turnaround times, certifications not on the About page, offers without an end date, and services outside the confirmed list. Without it, the claim stays out or carries a `[CONFIRM]` tag.
- **Current names only**: the client's retired brand names never appear.

Done when every field is filled or carries a `[CONFIRM]` tag and the link targets meet the content requirements.

## Step 5: Outline

Write the H2 and H3 skeleton from the dethrone plan. Give each heading a word budget, the keyword it carries, and its link slots, written as `[int: /url/]` and `[ext: url, claim it supports]`. Mark where each list goes. Phrase a heading as a question when the subtopic is one people ask.

Done when every subtopic in the dethrone plan has a heading, every secondary keyword and variant has a home, the primary has a spot in each third of the page, the budgets sum to the length target within the tolerance in PARAMETERS.md, and the outline's H2, list and link counts sit inside the content requirements.

## Step 6: Draft

Load the **copywriting** skill and answer its "Before Writing" questions from steps 1 to 4. On top of it:

- The H1 leads with the primary keyword and reads as a headline a person would write. Copywriting's headline formulas go in the subhead and H2s.
- **Answer first**: the first one or two sentences under each heading answer that heading outright. AI answers lift these sentences.
- Every section carries at least one specific: a number, a named place, part, standard or step, drawn from confirmed facts.
- Lists hold content that is genuinely a list: steps, parts, symptoms, what's included. Write list items as plain sentences or phrases (anti-ai-writing rules out bold-header bullets).
- Reach the length target with **useful content**, never restatement. When the draft runs short, add sections in this order:
  1. People Also Ask questions none of the three answer well
  2. Subtopics only one of the three covers
  3. Depth a customer would want before buying: what the work involves, what drives cost, how long it takes, what to expect, how to choose
  4. Owner questions that would unlock a section, tagged `[CONFIRM]` with the section drafted around the answer
- Put each link on the words that describe the page it points to.
- Give two or three options for the title, subhead and main CTA sentence, each with a one-line reason, and mark the recommended one.

Write the page copy in the draft format check.py reads:

```markdown
---
primary: brake repair norterra
variants: [brake service in norterra, norterra brake shop]
secondary: [brake pad replacement, squealing brakes, brake inspection cost]
type: location
site: example.com
slug: /norterra-brake-repair/
title: Brake repair in Norterra | Example Auto
meta: 140 to 155 characters of checkable facts with the primary keyword in them.
words_target: 1100
competitors: [rivalshop.com]
---

# Brake repair in Norterra

Body copy with [descriptive anchor](/service/brakes/) links...
```

Done when every outline slot holds copy and every link slot holds a link.

## Step 7: Edit

Load the **anti-ai-writing** skill and run every word through it: title, meta, headings, body, lists, FAQ and anchors. Work its if/then checks paragraph by paragraph. Then recheck the step 6 options, since persuasive lines are where AI tells return.

Done when every paragraph has passed. Note the notable fixes in the copy doc.

## Step 8: Check

```bash
python3 scripts/check.py draft.md --live --siblings <sibling URLs or files>
```

Fix every FAIL and rerun until the report is green. Read each WARN and either fix it or note why it stands. Then mark each E-E-A-T signal from seo-audit's "Content Quality Assessment" section as present on the page or tagged `[CONFIRM]`, and confirm the page beats each teardown on the points the dethrone plan named.

Done when the report is green and pasted into the copy doc, every E-E-A-T signal is marked, and every dethrone point is met or flagged.

## Step 9: Deliver

Save a new file named `[client]-[slug]-copy.md` in the client's folder. Jacob's existing notes stay untouched unless he asks for an edit. The copy doc holds, in order:

1. Search, intent, page type and ownership line (step 1)
2. Keywords with sources and baseline (step 2)
3. Teardowns, serp.py table and dethrone plan (step 3)
4. Metadata options (step 6)
5. Page copy in draft format
6. **Link plan**: internal links out; external links, each with the claim it supports and a short line from the source that supports it; and an **inbound edits** table of existing pages to change, each row with the page, the exact sentence and the anchor to wrap
7. **Schema notes**: `BlogPosting` for blog, `Service` for service and location, `BreadcrumbList` matching the real hierarchy, and `FAQPage` when the page has an FAQ, with text identical to the visible copy
8. Anti-ai-writing fixes and the check report

When a coding agent will build the page, also write `[client]-[slug]-handoff.md` per [HANDOFF.md](HANDOFF.md).

Reply to Jacob in two or three lines: what was written, the `[CONFIRM]` list, and any decision he owes (slug, title option, an overlap problem, a page that came in short, a secondary keyword that wants its own page). If the page counts toward a contract quota (for example "4 pages a month, at least 2 new"), say whether it counts as new or as a rewrite.
