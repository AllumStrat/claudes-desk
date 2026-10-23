# SEO writing parameters

The one place to change how seo-writing behaves. scripts/check.py and scripts/serp.py read the JSON block below, so a number changed here changes the check too. The prose explains each rule by its key.

```json
{
  "content": {
    "words": [900, 2500],
    "h1": 1,
    "h2": [2, 20],
    "paragraphs": [5, 30],
    "external_links": [1, 3],
    "lists": [1, 4]
  },
  "types": {
    "service":  {"faq": [4, 6]},
    "location": {"faq": [4, 6]},
    "blog":     {"faq": [0, 5]}
  },
  "length": {"parity_ceiling": 1.3, "tolerance": 0.15},
  "keywords": {"secondary": [2, 5], "variants": [2, 4], "primary_density": [0.003, 0.015], "primary_density_max": 0.02, "primary_h2_share_max": 0.5},
  "metadata": {"title_max": 60, "meta": [140, 155]},
  "internal": {"per_1000_words": [2, 5], "min": 2, "blog_min": 3, "inbound_min": 3, "anchor_words": [2, 7]},
  "readability": {"paragraph_max_sentences": 4, "max_words_between_headings": 350},
  "overlap": {"target": 0.25, "watch": 0.30, "rewrite": 0.45},
  "serp_exclude": ["reddit.com", "quora.com", "facebook.com", "instagram.com", "tiktok.com", "youtube.com", "x.com", "twitter.com", "linkedin.com", "pinterest.com", "nextdoor.com", "yelp.com", "trustpilot.com", "angi.com", "angieslist.com", "homeadvisor.com", "thumbtack.com", "bbb.org", "yellowpages.com", "mapquest.com", "houzz.com", "porch.com", "google.com", "wikipedia.org", "indeed.com", "glassdoor.com"],
  "generic_anchors": ["click here", "here", "learn more", "read more", "more", "this page", "this article", "this post", "link", "website"]
}
```

## Page types

`types` in the JSON holds the three types check.py knows. Each has subtypes, and the subtype decides the one question the page owns, so sibling pages never compete for the same search.

| Type | Subtype | Owns |
|---|---|---|
| location | Neighborhood (Norterra brake repair) | Proximity and local driving: the actual roads, how close it is, local conditions. "Is this shop near me." |
| location | City (Phoenix brake repair) | Reach: freeway access, coverage across the metro. "Is this shop worth the drive." |
| service | Specific job (Duramax repair) | Depth on one job the owner does well: generations, known failures, how it's diagnosed |
| service | Brand (GM repair) | The owner's background with that make, the models that come in, a real job as proof |
| service | Hub (/service/brakes/) | The whole service line across all areas. No place in the title or H1. |
| blog | Guide | One question answered (symptoms, cost factors, how to choose), linking to the service page that converts |

Every location page carries a **local cause** section: why this problem happens here (heat, commute pattern, terrain, the vehicles common in the area). It is the section that separates the page from its siblings.

## Content requirements

Hard limits for every page, checked by check.py. Count only the body copy under the H1: navigation, footer, breadcrumbs and sitewide components don't count.

| Element | Key | What counts |
|---|---|---|
| Words | `content.words` | Words under the H1, headings and lists included |
| H1 | `content.h1` | Exactly one |
| H2 | `content.h2` | Every H2, FAQ heading included |
| Paragraphs | `content.paragraphs` | Prose blocks, FAQ answers included; headings, lists and tables excluded |
| Internal links | `internal.per_1000_words`, never under `internal.min` (`internal.blog_min` on blogs) | Body links to the same site |
| External links | `content.external_links` | Body links to other sites |
| Lists | `content.lists` | Each bulleted or numbered list counts once, however many items |

## Length

Inside the `content.words` limits, the top 3 set the target. Google ranks pages that satisfy the query, and the pages already ranking show how much it takes.

- **Target** = the median main-content word count of the three pages from step 3 (serp.py prints it), raised to the `content.words` floor or lowered to its ceiling when the median falls outside.
- **Ceiling over parity**: no more than the median times `length.parity_ceiling`. Extra words go to subtopics the three miss, never to restatement.
- The draft passes when it lands within `length.tolerance` of the target.
- FAQ pairs per page: `types.*.faq`. Each answer opens with a sentence that answers the question.

## Keywords

One primary keyword per page, used **consistently**: in every required spot, spread across the whole body, and never stuffed.

- **Required spots**: H1 (leading it where the sentence allows), title (first half), slug, meta description and the first paragraph.
- **Spread**: the primary appears in each third of the body (opening, middle, closing), so it runs through the page instead of clustering at the top.
- **Density**: primary mentions divided by body words lands within `keywords.primary_density` (0.3% to 1.5%, about 3 to 15 mentions per 1,000 words). Over `keywords.primary_density_max` (2%) reads stuffed and fails. A mention counts with small words in between, so "brake repair in Norterra" counts for "brake repair norterra".
- **Headings**: the primary may carry H2s, but no more than `keywords.primary_h2_share_max` of them. The rest of the headings use secondaries, variants or plain language.
- **Variants**: `keywords.variants` synonyms or close variants of the primary ("brake service in Norterra", "brake work", "Norterra brake shop"), each used at least once. Variants carry the topic where the exact phrase would repeat.
- **Secondary keywords**: `keywords.secondary` per page, each sharing the primary's intent. Each appears in the body at least once, and at least one carries an H2. A secondary that makes a heading awkward moves to the body.

## Metadata and on-page

- **Title**: at most `metadata.title_max` characters, primary keyword in the first half, the site's brand suffix at the end.
- **Meta description**: within `metadata.meta` characters, built from checkable facts (credential, place, what's covered) with the primary keyword in it.
- **Headings**: sentence case, no skipped levels (H2 then H3, never H2 then H4).
- **Slug**: short, lowercase, hyphenated, built from the primary keyword's words, in the site's pattern.
- **Readability**: paragraphs of at most `readability.paragraph_max_sentences` sentences, and a heading at least every `readability.max_words_between_headings` words.

## Internal links

Count only links in the body copy. Navigation, footer, breadcrumbs and sitewide CTA components don't count.

- **Count**: `internal.per_1000_words` (about 2 to 4 on a 900-word page, 5 to 12 on a 2,500-word page), never under `internal.min`, and never under `internal.blog_min` on a blog post.
- **Required targets by type**, which fit inside that count:
  - service: its parent hub, one sibling service, the conversion page
  - location: the service hub, one nearby location page, the conversion page
  - blog: the money page it supports (linked in the first third of the post) and one related post
- **One URL, one link**: each URL is linked once in the body, where it is most relevant.
- **One anchor, one URL**: the same anchor text never points at two different pages.
- **Anchors** run `internal.anchor_words` words and describe the page they point to ("brake repair in Norterra"). Vary them; a sibling's exact target query appears as an anchor at most once per page. The `generic_anchors` list never appears as anchor text.
- **Clean targets**: link only to URLs that return 200, are indexable and are their own canonical. Point at the final URL, not a redirect.
- **Inbound**: the link plan names at least `internal.inbound_min` existing pages to edit, each with the exact sentence and the anchor to wrap. A page nothing links to is an orphan.

## External links

External links back up facts. Each one sits on a specific claim, and its anchor names the fact or the source ("NHTSA's 2024 recall data").

- **Count**: `content.external_links`. Every page links out at least once, so every page carries at least one claim worth a source.
- **Source order**, best first:
  1. Government and regulators (.gov, state agencies, NHTSA, EPA, OSHA, building codes)
  2. Standards bodies and manufacturer documentation (ASE, ANSI, OEM service bulletins and specs)
  3. Original research and peer-reviewed studies
  4. Recognized trade associations
  5. Major publications reporting on 1 to 4
- **Dates**: write the year into any sentence with a statistic. Prefer sources from the last three years unless the fact is stable (a code, a spec).
- **Verified**: the page returns 200 and states the claim. The link plan quotes the supporting line, under 15 words.
- **Who gets linked**: sources that hold one of the five ranks above. Competitors in the client's market, other agencies, affiliate listicles and content farms stay out (list the client's competitors under `competitors` in the draft so check.py flags them).
- **rel**: followed by default. `rel="sponsored"` for anything paid, `rel="ugc"` for forums and user content. If a source only feels safe with nofollow, find a better source.

## Overlap

6-gram Jaccard overlap between the draft and each sibling page's live text (check.py `--siblings`).

- Under `overlap.target`: good.
- Over `overlap.watch`: rewrite the shared passages if they're in the body.
- Over `overlap.rewrite`: the page fails and gets rewritten.
