// A short list of throwaway-inbox domains. Accounts on them can sign in and
// pay, but do not get the free audit. It only stops the lazy cases; the human
// check and per-connection limits do the rest.

const DOMAINS = new Set([
  '10minutemail.com', '10minutemail.net', '20minutemail.com', '33mailbox.com', 'burnermail.io', 'discard.email',
  'dispostable.com', 'emailondeck.com', 'fakeinbox.com', 'fakemail.net', 'getairmail.com', 'getnada.com',
  'grr.la', 'guerrillamail.biz', 'guerrillamail.com', 'guerrillamail.de', 'guerrillamail.info', 'guerrillamail.net',
  'guerrillamail.org', 'guerrillamailblock.com', 'inboxkitten.com', 'mail.tm', 'mailcatch.com', 'maildrop.cc',
  'mailinator.com', 'mailinator.net', 'mailnesia.com', 'mailpoof.com', 'mintemail.com', 'moakt.com', 'mohmal.com',
  'mytemp.email', 'nada.email', 'sharklasers.com', 'spam4.me', 'spamgourmet.com', 'temp-mail.io', 'temp-mail.org',
  'tempail.com', 'tempmail.com', 'tempmail.net', 'tempmailo.com', 'tempr.email', 'throwawaymail.com', 'tmpmail.net',
  'tmpmail.org', 'trash-mail.com', 'trashmail.com', 'trashmail.de', 'trashmail.net', 'yopmail.com', 'yopmail.fr',
  'yopmail.net',
]);

// True for a listed domain or any subdomain of one.
export function isDisposableEmail(email) {
  const domain = String(email).split('@')[1] || '';
  const parts = domain.split('.');
  for (let i = 0; i < parts.length - 1; i++) if (DOMAINS.has(parts.slice(i).join('.'))) return true;
  return false;
}
