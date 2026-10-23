// Scoring and output formats.
import { CATEGORIES, PRIORITIES } from './findings.js';

const PENALTY = { high: 25, medium: 10, low: 4 };

export function scoreResults(results) {
  const categories = [];
  for (const [key, def] of Object.entries(CATEGORIES)) {
    if (!results.applicable.has(key)) continue;
    const issues = results.issues.filter((i) => i.category === key);
    const passed = results.passed.filter((p) => p.category === key).length;
    const penalty = issues.reduce((n, i) => n + PENALTY[i.priority], 0);
    const score = Math.max(0, 100 - penalty);
    categories.push({ key, name: def.name, weight: def.weight, score, issues: issues.length, passed });
  }
  // Half area average, half raw issue count, so a few severe problems in one
  // area cannot hide behind many clean areas.
  const totalWeight = categories.reduce((n, c) => n + c.weight, 0) || 1;
  const areaAvg = categories.reduce((n, c) => n + c.score * c.weight, 0) / totalWeight;
  const count = (p) => results.issues.filter((i) => i.priority === p).length;
  const raw = Math.max(0, 100 - 6 * count('high') - 2.5 * count('medium') - 1 * count('low'));
  const score = Math.round((areaAvg + raw) / 2);
  return { score, grade: grade(score), categories };
}

export function grade(score) {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

export function sortIssues(issues) {
  const order = (p) => PRIORITIES.indexOf(p);
  const catOrder = Object.keys(CATEGORIES);
  return [...issues].sort((a, b) => order(a.priority) - order(b.priority) || catOrder.indexOf(a.category) - catOrder.indexOf(b.category));
}

// Escapes text for Markdown and HTML so page content cannot inject markup.
export function mdEscape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`*_[\]|#])/g, '\\$1')
    .replace(/\r?\n/g, ' ');
}

const LABEL = { high: 'High', medium: 'Medium', low: 'Low' };

export function toMarkdown(report) {
  const lines = [];
  lines.push(`# SEO audit: ${mdEscape(report.finalUrl || report.url)}`);
  lines.push('');
  lines.push(`Score: **${report.score}/100 (${report.grade})** · ${report.counts.high} high, ${report.counts.medium} medium, ${report.counts.low} low priority issues · ${report.counts.passed} checks passed`);
  lines.push(`Audited ${mdEscape(report.auditedAt)} · ${report.pagesCrawled} page(s) crawled`);
  lines.push('');
  lines.push('| Area | Score | Issues |');
  lines.push('| --- | --- | --- |');
  for (const c of report.categories) lines.push(`| ${mdEscape(c.name)} | ${c.score} | ${c.issues} |`);
  lines.push('');
  for (const p of PRIORITIES) {
    const items = report.issues.filter((i) => i.priority === p);
    if (!items.length) continue;
    lines.push(`## ${LABEL[p]} priority`);
    lines.push('');
    for (const i of items) {
      lines.push(`### ${mdEscape(i.issue)}`);
      lines.push(`- **Issue:** ${mdEscape(i.issue)}`);
      lines.push(`- **Impact:** ${mdEscape(i.impact)}`);
      lines.push(`- **Evidence:** ${mdEscape(i.evidence)}`);
      lines.push(`- **Fix:** ${mdEscape(i.fix)}`);
      lines.push(`- **Priority:** ${LABEL[i.priority]}${i.source === 'judgment' ? ` (AI judgment, ${Math.round((i.confidence ?? 0) * 100)}% confidence)` : ''}`);
      lines.push('');
    }
  }
  if (report.insights.length) {
    lines.push('## Notes');
    lines.push('');
    for (const n of report.insights) lines.push(`- ${mdEscape(n.label)}: ${mdEscape(n.value)}`);
    lines.push('');
  }
  if (report.passed.length) {
    lines.push('## Passed');
    lines.push('');
    for (const p of report.passed) lines.push(`- ${mdEscape(p.label)}`);
    lines.push('');
  }
  return lines.join('\n');
}
