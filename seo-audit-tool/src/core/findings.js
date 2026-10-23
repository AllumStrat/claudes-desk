// Shape of every audit result. Each problem is reported as
// Issue / Impact / Evidence / Fix / Priority.

export const CATEGORIES = {
  indexing: { name: 'Crawling and indexing', weight: 3 },
  onpage: { name: 'On-page basics', weight: 3 },
  content: { name: 'Content', weight: 2 },
  links: { name: 'Links', weight: 2 },
  images: { name: 'Images', weight: 1 },
  schema: { name: 'Structured data', weight: 2 },
  social: { name: 'Social sharing', weight: 1 },
  performance: { name: 'Performance', weight: 2 },
  security: { name: 'Security', weight: 1.5 },
  local: { name: 'Local business signals', weight: 2 },
};

export const PRIORITIES = ['high', 'medium', 'low'];

export function issue(id, category, priority, { issue: title, impact, evidence, fix, source = 'rule', confidence }) {
  if (!CATEGORIES[category]) throw new Error(`unknown category ${category}`);
  if (!PRIORITIES.includes(priority)) throw new Error(`unknown priority ${priority}`);
  const out = { id, category, priority, issue: title, impact, evidence, fix, source };
  if (confidence !== undefined) out.confidence = confidence;
  return out;
}

export function pass(id, category, label) {
  return { id, category, label };
}

// Collects issues and passes from a check function.
export class Results {
  constructor() {
    this.issues = [];
    this.passed = [];
    this.insights = [];
    this.applicable = new Set();
  }

  add(item) {
    if (!item) return;
    this.applicable.add(item.category);
    if ('priority' in item) this.issues.push(item);
    else this.passed.push(item);
  }

  insight(category, label, value) {
    this.insights.push({ category, label, value });
  }
}
