// Sends account email. Providers:
//   cloudflare  Cloudflare Email Service binding (env.EMAIL.send), for the Worker
//   resend      Resend's HTTP API with RESEND_API_KEY
//   log         prints the message to the terminal, for local testing only
//   mock        keeps messages in memory, for tests
// Messages are plain text, plus an HTML copy built only from escaped text.

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function textToHtml(text) {
  return `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5">${escapeHtml(text)
    .split('\n')
    .join('<br>')}</div>`;
}

export function createMailer({ provider = 'log', from, binding, apiKey, fetchImpl = globalThis.fetch, log = console.log } = {}) {
  const sent = [];
  const send = async ({ to, subject, text }) => {
    const message = { from, to, subject, text, html: textToHtml(text) };
    switch (provider) {
      case 'mock':
        sent.push(message);
        return;
      case 'log':
        log(`\n[email] to ${to}\n[email] subject: ${subject}\n${text}\n`);
        return;
      case 'cloudflare':
        if (!binding) throw new Error('EMAIL binding missing');
        await binding.send(message);
        return;
      case 'resend': {
        const res = await fetchImpl('https://api.resend.com/emails', {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify(message),
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw new Error(`email provider returned ${res.status}`);
        return;
      }
      default:
        throw new Error('unknown email provider');
    }
  };
  return { provider, send, sent };
}

export function signInEmail({ appName, link, minutes }) {
  return {
    subject: `Your ${appName} sign-in link`,
    text: [
      `Here is your link to sign in to ${appName}:`,
      '',
      link,
      '',
      `It works once, for the next ${minutes} minutes.`,
      'If you did not ask for this, you can ignore this email.',
    ].join('\n'),
  };
}

export function watchEmail({ appName, appOrigin, url, diff }) {
  const lines = [`Your weekly ${appName} check of ${url} is done.`, ''];
  if (diff.scoreBefore === null) {
    lines.push(`First check saved. Score: ${diff.scoreAfter}/100. You will hear from us when something changes.`);
  } else {
    const delta = diff.scoreAfter - diff.scoreBefore;
    lines.push(`Score: ${diff.scoreAfter}/100 (${delta > 0 ? 'up' : delta < 0 ? 'down' : 'no change'}${delta ? ` ${Math.abs(delta)}` : ''} from ${diff.scoreBefore}).`);
  }
  if (diff.newIssues.length) {
    lines.push('', `New problems (${diff.newIssues.length}):`);
    for (const i of diff.newIssues.slice(0, 10)) lines.push(`- ${i.priority} priority: ${i.issue}`);
  }
  if (diff.fixedIssues.length) {
    lines.push('', `Fixed since last time (${diff.fixedIssues.length}):`);
    for (const i of diff.fixedIssues.slice(0, 10)) lines.push(`- ${i.issue}`);
  }
  lines.push('', `See the full report: ${appOrigin}/`, '', 'To stop these emails, remove the saved site from your account.');
  return { subject: `Weekly SEO check: ${url}`, text: lines.join('\n') };
}
