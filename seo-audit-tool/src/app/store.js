// Every database read and write the app makes. Written against the D1 API
// (prepare/bind/first/all/run), which the local Node server imitates.

import { randomId } from './crypto.js';

const DEAD_STATUSES = new Set(['canceled', 'unpaid', 'incomplete_expired']);
const MAX_STORED_REPORT = 256 * 1024;
const FREE_AUDIT_DAYS = 30;

export function createStore(db, { runsPerPeriod = 20, graceMs = 3 * 86_400_000 } = {}) {
  const one = (sql, ...args) => db.prepare(sql).bind(...args).first();
  const all = async (sql, ...args) => (await db.prepare(sql).bind(...args).all()).results || [];
  const run = (sql, ...args) => db.prepare(sql).bind(...args).run();
  const changed = (res) => Number(res?.meta?.changes ?? 0);

  const store = {
    runsPerPeriod,

    // A user has the paid plan while a paid period (plus a few days of grace
    // for a late renewal) is running and Stripe has not ended the subscription.
    isPro(user, now = Date.now()) {
      return Boolean(user && user.plan === 'pro' && !DEAD_STATUSES.has(user.sub_status) && user.period_end && user.period_end + graceMs > now);
    },

    // Sign-in tokens
    async saveLoginToken(tokenHash, email, now, ttlMs) {
      await run('INSERT INTO login_tokens (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)', tokenHash, email, now, now + ttlMs);
    },
    // The email a token is for, without using it up.
    async peekLoginToken(tokenHash, now) {
      const row = await one('SELECT email FROM login_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?', tokenHash, now);
      return row?.email ?? null;
    },
    // Uses a token exactly once, and only for the email the person confirmed.
    // Returns the email, or null.
    async useLoginToken(tokenHash, now, email) {
      const row = await one(
        'UPDATE login_tokens SET used_at = ? WHERE token_hash = ? AND email = ? AND used_at IS NULL AND expires_at > ? RETURNING email',
        now,
        tokenHash,
        email,
        now,
      );
      return row?.email ?? null;
    },

    // Users
    async getUserByEmail(email) {
      return one('SELECT * FROM users WHERE email = ?', email);
    },
    async getUser(id) {
      return one('SELECT * FROM users WHERE id = ?', id);
    },
    async upsertUser(email, now) {
      await run('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?) ON CONFLICT (email) DO NOTHING', randomId(), email, now);
      return store.getUserByEmail(email);
    },
    async deleteUser(id) {
      await db.batch([
        db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id),
        db.prepare('DELETE FROM audits WHERE user_id = ?').bind(id),
        db.prepare('DELETE FROM users WHERE id = ?').bind(id),
      ]);
    },

    // Sessions
    async createSession(idHash, userId, now, ttlMs) {
      await run('INSERT INTO sessions (id_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', idHash, userId, now, now + ttlMs);
    },
    async getSessionUser(idHash, now) {
      return one('SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.id_hash = ? AND sessions.expires_at > ?', idHash, now);
    },
    async deleteSession(idHash) {
      await run('DELETE FROM sessions WHERE id_hash = ?', idHash);
    },

    // Credits. Each claim is one conditional UPDATE, so two audits started at
    // the same moment cannot both spend the last run.
    async claimFree(user, emailKey, now) {
      const claim = await run('INSERT INTO free_claims (email_key, user_id, claimed_at) VALUES (?, ?, ?) ON CONFLICT (email_key) DO NOTHING', emailKey, user.id, now);
      if (!changed(claim)) return false;
      const res = await run('UPDATE users SET free_used = 1 WHERE id = ? AND free_used = 0', user.id);
      if (changed(res)) return true;
      await run('DELETE FROM free_claims WHERE email_key = ? AND user_id = ?', emailKey, user.id);
      return false;
    },
    async refundFree(user, emailKey) {
      await db.batch([
        db.prepare('DELETE FROM free_claims WHERE email_key = ? AND user_id = ?').bind(emailKey, user.id),
        db.prepare('UPDATE users SET free_used = 0 WHERE id = ?').bind(user.id),
      ]);
    },
    async claimRun(user) {
      const row = await one('UPDATE users SET runs_left = runs_left - 1 WHERE id = ? AND runs_left > 0 RETURNING runs_left', user.id);
      return row ? { ok: true, runsLeft: row.runs_left } : { ok: false };
    },
    async refundRun(user) {
      await run('UPDATE users SET runs_left = MIN(runs_left + 1, ?) WHERE id = ?', runsPerPeriod, user.id);
    },

    // Audit history
    async saveAudit({ userId, url, kind, report, now }) {
      const text = JSON.stringify(report);
      // runAudit keeps reports far below this; refuse anything bigger rather
      // than fill the database (D1 also refuses rows over 2 MB).
      if (text.length > MAX_STORED_REPORT) throw new Error('report too large to store');
      const id = randomId();
      await run(
        'INSERT INTO audits (id, user_id, url, kind, created_at, score, grade, report) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        id,
        userId,
        url,
        kind,
        now,
        report.score ?? null,
        report.grade ?? null,
        text,
      );
      return id;
    },
    async listAudits(userId, limit = 50) {
      return all('SELECT id, url, kind, created_at, score, grade FROM audits WHERE user_id = ? ORDER BY created_at DESC LIMIT ?', userId, limit);
    },
    async getAudit(userId, id) {
      const row = await one('SELECT * FROM audits WHERE user_id = ? AND id = ?', userId, id);
      return row ? { ...row, report: JSON.parse(row.report) } : null;
    },
    async lastAuditFor(userId, url) {
      const row = await one('SELECT * FROM audits WHERE user_id = ? AND url = ? ORDER BY created_at DESC LIMIT 1', userId, url);
      return row ? { ...row, report: JSON.parse(row.report) } : null;
    },

    // Weekly re-check
    async setWatch(userId, url, nextAt) {
      await run('UPDATE users SET watch_url = ?, watch_next_at = ? WHERE id = ?', url, url ? nextAt : null, userId);
    },
    async lastWeeklyAt(userId) {
      const row = await one("SELECT MAX(created_at) AS at FROM audits WHERE user_id = ? AND kind = 'weekly'", userId);
      return row?.at ?? null;
    },
    async dueWatches(now, limit) {
      return all('SELECT * FROM users WHERE watch_url IS NOT NULL AND watch_next_at <= ? ORDER BY watch_next_at LIMIT ?', now, limit);
    },
    // Moves the next run forward before auditing, so a crash does not make
    // the same site get audited every hour.
    async claimWatch(userId, expectedAt, nextAt) {
      return changed(await run('UPDATE users SET watch_next_at = ? WHERE id = ? AND watch_next_at = ?', nextAt, userId, expectedAt)) === 1;
    },

    // Stripe
    async setStripeCustomer(userId, customerId) {
      await run('UPDATE users SET stripe_customer_id = ? WHERE id = ? AND stripe_customer_id IS NULL', customerId, userId);
      return store.getUser(userId);
    },
    // Checkout. A short lock lets only one request make a session; the
    // session is then kept until it expires so other tabs reuse it.
    async lockCheckout(userId, now, lockMs = 30_000) {
      return changed(
        await run(
          'UPDATE users SET checkout_url = NULL, checkout_expires_at = ? WHERE id = ? AND (checkout_expires_at IS NULL OR checkout_expires_at <= ?)',
          now + lockMs,
          userId,
          now,
        ),
      ) === 1;
    },
    async saveCheckout(userId, url, expiresAt) {
      await run('UPDATE users SET checkout_url = ?, checkout_expires_at = ? WHERE id = ?', url, expiresAt, userId);
    },
    async clearCheckout(userId) {
      await run('UPDATE users SET checkout_url = NULL, checkout_expires_at = NULL WHERE id = ?', userId);
    },
    // A full refund or a dispute ends the current paid period. The period end
    // stays, so a replay of the same invoice cannot turn it back on; the next
    // period's invoice does.
    async revokePaid(customer) {
      return changed(await run("UPDATE users SET plan = 'free', runs_left = 0, watch_url = NULL, watch_next_at = NULL WHERE stripe_customer_id = ?", customer));
    },

    // Records an event id. False means it was already handled.
    async markEvent(id, now) {
      return changed(await run('INSERT INTO stripe_events (id, received_at) VALUES (?, ?) ON CONFLICT (id) DO NOTHING', id, now)) === 1;
    },
    async forgetEvent(id) {
      await run('DELETE FROM stripe_events WHERE id = ?', id);
    },
    async linkCheckout({ customer, subscription, userId }) {
      if (!customer || !userId) return 0;
      return changed(
        await run(
          'UPDATE users SET stripe_subscription_id = COALESCE(?, stripe_subscription_id), checkout_url = NULL, checkout_expires_at = NULL WHERE id = ? AND stripe_customer_id = ?',
          subscription,
          userId,
          customer,
        ),
      );
    },
    // A paid invoice starts a new period: 20 fresh runs, unused ones do not
    // carry over. A replayed or older invoice (same or earlier period) is ignored.
    async applyPaidInvoice({ customer, invoiceId, periodEnd }) {
      return changed(
        await run(
          "UPDATE users SET plan = 'pro', sub_status = 'active', runs_left = ?, period_end = ?, last_invoice_id = ? WHERE stripe_customer_id = ? AND (period_end IS NULL OR period_end < ?)",
          runsPerPeriod,
          periodEnd,
          invoiceId,
          customer,
          periodEnd,
        ),
      );
    },
    // Status changes are applied in event order, and an older event is ignored.
    // An ending event only counts for the subscription on file, so a late
    // "deleted" for an old subscription cannot end a newer one.
    async applySubscriptionStatus({ customer, subscription, status, eventAt }) {
      if (DEAD_STATUSES.has(status)) {
        return changed(
          await run(
            "UPDATE users SET plan = 'free', runs_left = 0, sub_status = ?, sub_event_at = ?, watch_url = NULL, watch_next_at = NULL WHERE stripe_customer_id = ? AND sub_event_at <= ? AND (stripe_subscription_id IS NULL OR stripe_subscription_id = ?)",
            status,
            eventAt,
            customer,
            eventAt,
            subscription,
          ),
        );
      }
      return changed(
        await run(
          'UPDATE users SET sub_status = ?, stripe_subscription_id = ?, sub_event_at = ? WHERE stripe_customer_id = ? AND sub_event_at <= ?',
          status,
          subscription,
          eventAt,
          customer,
          eventAt,
        ),
      );
    },

    // Housekeeping, run by the hourly cron. Audits of accounts without the
    // plan are kept for 30 days.
    async cleanup(now, { keepAudits = 100 } = {}) {
      await db.batch([
        db.prepare("DELETE FROM audits WHERE created_at < ? AND user_id IN (SELECT id FROM users WHERE plan != 'pro')").bind(now - FREE_AUDIT_DAYS * 86_400_000),
        db.prepare('DELETE FROM login_tokens WHERE expires_at < ?').bind(now - 86_400_000),
        db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
        db.prepare('DELETE FROM counters WHERE window_start < ?').bind(now - 2 * 86_400_000),
        db.prepare('DELETE FROM stripe_events WHERE received_at < ?').bind(now - 30 * 86_400_000),
        db
          .prepare(
            'DELETE FROM audits WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) AS n FROM audits) WHERE n > ?)',
          )
          .bind(keepAudits),
      ]);
    },
  };
  return store;
}
