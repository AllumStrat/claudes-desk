// Command line audit: node src/node/cli.js <url> [--json] [--out file]
import { writeFile } from 'node:fs/promises';
import { runAudit } from '../core/audit.js';
import { toMarkdown } from '../core/report.js';
import { buildDeps } from './config.js';

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith('--'));
const asJson = args.includes('--json');
const outIdx = args.indexOf('--out');
const outFile = outIdx !== -1 ? args[outIdx + 1] : null;

if (!url) {
  console.error('Usage: npm run audit -- <url> [--json] [--out report.md]');
  process.exit(2);
}

try {
  const { auditDeps } = buildDeps();
  const report = await runAudit(url, auditDeps());
  const text = asJson ? JSON.stringify(report, null, 2) : toMarkdown(report);
  if (outFile) {
    await writeFile(outFile, text);
    console.log(`Saved ${outFile} (score ${report.score}, ${report.issues.length} issues)`);
  } else {
    console.log(text);
  }
} catch (err) {
  console.error(`Audit failed: ${err.message}`);
  process.exit(1);
}
