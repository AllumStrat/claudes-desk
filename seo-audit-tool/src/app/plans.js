// What each plan sees. The free report is cut down on the server, so the
// locked parts never reach the browser.

export const FREE_DEFAULTS = { issues: 5, fixes: 1 };

export function freeReport(report, { issues = FREE_DEFAULTS.issues, fixes = FREE_DEFAULTS.fixes } = {}) {
  const shown = report.issues.slice(0, issues).map((i, n) => (n < fixes ? { ...i } : { ...i, fix: null, locked: true }));
  return {
    ...report,
    limited: true,
    issues: shown,
    lockedIssues: Math.max(0, report.issues.length - shown.length),
    lockedFixes: shown.filter((i) => i.locked).length + Math.max(0, report.issues.length - shown.length),
    passed: [],
    insights: [],
    pages: report.pages.map((p) => ({ url: p.url, status: p.status, error: p.error })),
  };
}

// Compares two reports of the same site by issue id.
export function diffReports(before, after) {
  const prev = new Map((before?.issues || []).map((i) => [i.id, i]));
  const next = new Map((after?.issues || []).map((i) => [i.id, i]));
  return {
    scoreBefore: before ? before.score : null,
    scoreAfter: after.score,
    newIssues: [...next.values()].filter((i) => !prev.has(i.id)),
    fixedIssues: before ? [...prev.values()].filter((i) => !next.has(i.id)) : [],
  };
}

export function hasChanges(diff) {
  return diff.scoreBefore === null || diff.scoreBefore !== diff.scoreAfter || diff.newIssues.length > 0 || diff.fixedIssues.length > 0;
}
