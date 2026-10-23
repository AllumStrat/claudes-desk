// The audit tool's browser side. Page-derived text is only ever added as text
// nodes, never parsed as markup, so nothing from an audited site can run here.
//
// Every element is found by `data-sat` inside the tool's own root, so the
// page can hold other forms and ids without clashing.

type Json = Record<string, any>;

const PRIORITY: Record<string, string> = { high: "High", medium: "Medium", low: "Low" };
const PENDING_KEY = "sat-pending-url";
const CHECK = "M4.5 10.5l3.5 3.5 7.5-8";

// localStorage can throw (private windows, blocked storage). The tool works
// without it; it only remembers the URL across the sign-in email.
const store = {
  get(k: string) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string | null) {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {}
  },
};

function el(tag: string, attrs: Record<string, string> = {}, ...children: unknown[]) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function svgCheck() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", CHECK);
  svg.append(p);
  return svg;
}

const band = (score: number) => (score >= 80 ? "good" : score >= 50 ? "mid" : "low");

function download(name: string, type: string, text: string) {
  const blob = new Blob([text], { type });
  const a = el("a", { href: URL.createObjectURL(blob), download: name }) as HTMLAnchorElement;
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

// Payment pages must be Stripe's own, never a link from anywhere else.
function stripeUrl(url: string) {
  try {
    const u = new URL(url);
    if (u.protocol === "https:" && (u.hostname === "checkout.stripe.com" || u.hostname === "billing.stripe.com")) return u.href;
  } catch {}
  return null;
}

let turnstileLoading: Promise<any> | undefined;
function loadTurnstile() {
  turnstileLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.onload = () => resolve((window as any).turnstile);
    s.onerror = reject;
    document.head.append(s);
  });
  return turnstileLoading;
}

export function mount(root: HTMLElement) {
  const base = root.dataset.api || "";
  const $ = <T extends HTMLElement = HTMLElement>(name: string) => root.querySelector<T>(`[data-sat="${name}"]`)!;
  const statusEl = $("status");
  const reportEl = $("report");
  const urlInput = $<HTMLInputElement>("url");
  const runButton = $<HTMLButtonElement>("run");
  const state: { user: Json | null; siteKey: string | null; billingEnabled: boolean; widgets: Record<string, { id?: string; token: string }> } = {
    user: null,
    siteKey: null,
    billingEnabled: false,
    widgets: {},
  };

  function say(text: string, tone: "info" | "error" | "ok" = "info") {
    statusEl.textContent = text;
    statusEl.dataset.tone = tone;
  }

  async function api(path: string, body?: unknown) {
    const init: RequestInit =
      body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
    let res: Response;
    try {
      // On another origin the session cookie only travels with "include".
      res = await fetch(base + path, { credentials: base ? "include" : "same-origin", ...init });
    } catch {
      return { ok: false, status: 0, data: { error: "Could not reach the audit server. Check your connection and try again." } as Json };
    }
    const data: Json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  const message = (data: Json, fallback: string) => (typeof data?.error === "string" ? data.error : fallback);

  function goToStripe(url: string) {
    const safe = stripeUrl(url);
    if (safe) location.assign(safe);
    else say("Something went wrong opening the payment page.", "error");
  }

  // --- human check (Cloudflare Turnstile) -------------------------------

  async function showHumanCheck(name: string) {
    if (!state.siteKey || state.widgets[name]) return;
    const ts = await loadTurnstile().catch(() => null);
    if (!ts) return;
    const slot: { id?: string; token: string } = { token: "" };
    slot.id = ts.render($(`ts-${name}`), {
      sitekey: state.siteKey,
      callback: (t: string) => {
        slot.token = t;
      },
      "expired-callback": () => {
        slot.token = "";
      },
    });
    state.widgets[name] = slot;
  }

  // Tokens work once, so each one is cleared after it is sent.
  function takeHumanToken(name: string) {
    const slot = state.widgets[name];
    if (!slot) return undefined;
    const t = slot.token;
    slot.token = "";
    (window as any).turnstile?.reset(slot.id);
    return t || undefined;
  }

  // --- report -------------------------------------------------------------

  function renderIssue(i: Json) {
    const p = i.priority in PRIORITY ? i.priority : "low";
    const tag = i.source === "judgment" ? `AI judgment, ${Math.round((i.confidence || 0) * 100)}%` : PRIORITY[p];
    return el(
      "li",
      {},
      el(
        "details",
        { class: "sat-issue", "data-p": p },
        el("summary", {}, el("span", { class: "sat-tag" }, tag), el("span", { class: "sat-issue-t" }, i.issue)),
        el(
          "dl",
          {},
          el("dt", {}, "Impact"),
          el("dd", {}, i.impact),
          el("dt", {}, "Evidence"),
          el("dd", { class: "sat-evidence" }, i.evidence),
          el("dt", {}, "Fix"),
          i.locked ? el("dd", { class: "sat-locked" }, "The fix is in the full report, with the $5 plan.") : el("dd", { class: "sat-fix" }, i.fix),
        ),
      ),
    );
  }

  function renderReport(r: Json) {
    reportEl.replaceChildren();
    let host = "site";
    try {
      host = new URL(r.finalUrl).hostname;
    } catch {}

    const dial = el("div", { class: "sat-dial", "data-band": band(r.score) }, el("div", { class: "sat-dial-n" }, String(r.score), el("small", {}, `out of 100 · ${r.grade}`)));
    dial.style.setProperty("--v", String(Math.max(0, Math.min(100, Number(r.score) || 0))));
    const seconds = Math.round(r.durationMs / 100) / 10;
    const counts = el(
      "ul",
      { class: "sat-counts" },
      ...[
        ["high", "high", "var(--high)"],
        ["medium", "medium", "var(--medium)"],
        ["low", "low", "var(--on-deep-mut)"],
        ["passed", "passed", "var(--pass)"],
      ].map(([k, label, c]) => {
        const dot = el("i");
        dot.style.setProperty("--c", c);
        return el("li", {}, dot, el("b", {}, String(r.counts[k] ?? 0)), label);
      }),
    );
    const actions = el("div", { class: "sat-actions" });
    const jsonBtn = el("button", { type: "button", class: "btn btn-on-deep" }, "Download JSON");
    jsonBtn.addEventListener("click", () => download(`seo-audit-${host}.json`, "application/json", JSON.stringify(r, null, 2)));
    actions.append(jsonBtn);
    reportEl.append(
      el(
        "div",
        { class: "sat-summary" },
        dial,
        el(
          "div",
          {},
          el("h2", { class: "sat-summary-h" }, r.finalUrl),
          el("p", { class: "sat-summary-sub" }, `${r.pagesCrawled} ${r.pagesCrawled === 1 ? "page" : "pages"} checked in ${seconds}s`),
          counts,
          actions,
        ),
      ),
    );

    if (r.judgment) {
      reportEl.append(el("p", { class: "sat-note" }, r.judgment.used ? "AI judgment checks ran on the page content." : r.judgment.error || "AI judgment did not run."));
    }

    const areas = el("ul", { class: "sat-areas-grid" });
    for (const c of r.categories) {
      const meter = el("div", { class: "sat-meter", "data-band": band(c.score) }, el("i"));
      (meter.firstChild as HTMLElement).style.width = `${Math.max(2, c.score)}%`;
      areas.append(
        el(
          "li",
          { class: "sat-area" },
          el("span", { class: "sat-area-name" }, c.name),
          el("span", { class: "sat-area-n" }, String(c.score), el("small", {}, c.issues ? `${c.issues} ${c.issues === 1 ? "issue" : "issues"}` : "clear")),
          meter,
        ),
      );
    }
    reportEl.append(el("section", {}, el("h3", { class: "sat-sec-h" }, "Score by Area"), areas));

    for (const p of ["high", "medium", "low"]) {
      const items = r.issues.filter((i: Json) => i.priority === p);
      if (!items.length) continue;
      const list = el("ul", { class: "sat-issues" }, ...items.map(renderIssue));
      reportEl.append(el("section", {}, el("h3", { class: "sat-sec-h" }, `${PRIORITY[p]} Priority `, el("span", {}, String(items.length))), list));
    }
    // Open the first issue so the fix shown on a free audit is in view.
    reportEl.querySelector<HTMLDetailsElement>(".sat-issue")?.setAttribute("open", "");

    if (r.limited) {
      const box = el(
        "div",
        { class: "sat-upsell" },
        el(
          "p",
          {},
          el("strong", {}, `This free audit shows ${r.issues.length} of ${r.issues.length + (r.lockedIssues || 0)} issues.`),
          " The full report has the fix for every one of them and the list of checks that passed.",
        ),
      );
      if (state.billingEnabled) {
        const b = el("button", { type: "button", class: "btn btn-solid" }, "Unlock the Full Report for $5");
        b.addEventListener("click", upgrade);
        box.append(b);
      }
      reportEl.append(box);
    }

    if (r.insights?.length) {
      const ul = el("ul", { class: "sat-list" }, ...r.insights.map((n: Json) => el("li", {}, `${n.label}: ${n.value}`)));
      reportEl.append(el("section", {}, el("h3", { class: "sat-sec-h" }, "Notes"), ul));
    }
    if (r.passed?.length) {
      const ul = el("ul", { class: "sat-passed" }, ...r.passed.map((p: Json) => el("li", {}, svgCheck(), p.label)));
      reportEl.append(el("details", { class: "sat-more" }, el("summary", {}, `Passed checks (${r.passed.length})`), ul));
    }
    if (r.pages?.length > 1) {
      const rows = r.pages.map((pg: Json) => el("tr", {}, el("td", {}, pg.url), el("td", {}, pg.status || pg.error || ""), el("td", {}, pg.title || "")));
      const table = el(
        "div",
        { class: "sat-table-wrap" },
        el("table", { class: "sat-table" }, el("thead", {}, el("tr", {}, el("th", {}, "URL"), el("th", {}, "Status"), el("th", {}, "Title"))), el("tbody", {}, ...rows)),
      );
      reportEl.append(el("details", { class: "sat-more" }, el("summary", {}, `Pages crawled (${r.pages.length})`), table));
    }
    reportEl.hidden = false;
  }

  // --- account ------------------------------------------------------------

  function renderAccount() {
    const u = state.user;
    $("account").hidden = !u;
    $("footer").hidden = !u;
    $("signin").hidden = Boolean(u);
    if (!u) {
      showHumanCheck("signin");
      $("watch").hidden = true;
      $("history").hidden = true;
      return;
    }
    $("account-email").textContent = u.email;
    const pro = u.plan === "pro";
    $("account-plan").textContent = pro
      ? `$5 plan · ${u.runsLeft} of ${u.runsPerMonth} audits left · renews ${new Date(u.periodEnd).toLocaleDateString()}`
      : u.freeUsed
        ? "Free audit used"
        : "Your first audit is free";
    $("upgrade").hidden = pro || !state.billingEnabled;
    $("billing").hidden = !u.hasBilling || !state.billingEnabled;
    $("watch").hidden = !pro;
    $<HTMLInputElement>("watch-url").value = u.watchUrl || "";
    $("watch-status").textContent = u.watchUrl ? `Checking ${u.watchUrl} every week.` : "No site saved yet.";
    if (!pro) showHumanCheck("audit");
    if (pro) loadHistory();
    else $("history").hidden = true;
  }

  async function loadMe() {
    const { ok, data } = await api("/api/me");
    if (!ok) return say(message(data, "The audit server is not answering right now."), "error");
    state.user = data.user;
    state.siteKey = data.turnstileSiteKey;
    state.billingEnabled = data.billingEnabled;
    renderAccount();
  }

  async function loadHistory() {
    const { ok, data } = await api("/api/audits");
    if (!ok) return;
    const list = $("history-list");
    list.replaceChildren();
    for (const a of data.audits) {
      const open = el("button", { type: "button", class: "btn btn-ghost" }, "Open");
      open.addEventListener("click", () => openAudit(a.id));
      const when = new Date(a.created_at).toLocaleString();
      list.append(
        el(
          "li",
          {},
          el("span", { class: "sat-h-url" }, a.url),
          el("span", { class: "sat-h-meta" }, `${a.score ?? "?"}/100 · ${when}${a.kind === "weekly" ? " · weekly check" : ""}`),
          open,
        ),
      );
    }
    $("history").hidden = !data.audits.length;
  }

  async function openAudit(id: string) {
    const { ok, data } = await api(`/api/audits/${encodeURIComponent(id)}`);
    if (!ok) return say(message(data, "Could not open that audit."), "error");
    say("");
    renderReport(data.report);
    reportEl.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function upgrade() {
    const { ok, data } = await api("/api/billing/checkout", {});
    if (ok) goToStripe(data.url);
    else say(message(data, "Could not start the payment."), "error");
  }

  $("upgrade").addEventListener("click", upgrade);

  $("billing").addEventListener("click", async () => {
    const { ok, data } = await api("/api/billing/portal", {});
    if (ok) goToStripe(data.url);
    else say(message(data, "Could not open billing."), "error");
  });

  $("signout").addEventListener("click", async () => {
    await api("/api/auth/logout", {});
    state.user = null;
    reportEl.hidden = true;
    say("");
    renderAccount();
  });

  $("delete-account").addEventListener("click", async () => {
    if (!window.confirm("Delete your account and all saved audits? This cannot be undone.")) return;
    const { ok, data } = await api("/api/account/delete", {});
    say(ok ? "Your account is deleted." : message(data, "Could not delete the account."), ok ? "ok" : "error");
    if (ok) {
      state.user = null;
      reportEl.hidden = true;
      renderAccount();
    }
  });

  $("signin-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const b = $<HTMLButtonElement>("signin-button");
    const email = $<HTMLInputElement>("email").value.trim();
    if (!email) return $("email").focus();
    const pending = urlInput.value.trim();
    if (pending) store.set(PENDING_KEY, pending);
    b.disabled = true;
    const { ok, data } = await api("/api/auth/start", { email, turnstileToken: takeHumanToken("signin") });
    say(message(data, data.message || "Check your email for a sign-in link."), ok ? "ok" : "error");
    b.disabled = false;
  });

  // The emailed link is <page>#signin=<token>. The token is only used up when
  // the person presses the button, so mail scanners that open links cannot use
  // it. The panel shows which email the link signs in to, because someone
  // could send you a link to their own account.
  // It is also handled on hashchange, for a mail app that reuses this tab.
  function handleSigninLink() {
    const signinToken = (location.hash.match(/^#signin=([A-Za-z0-9_-]{43})$/) || [])[1];
    if (!signinToken) return;
    history.replaceState(null, "", location.pathname);
    $("finish").hidden = false;
    $("finish-text").textContent = "Checking your sign-in link.";
    $("finish-note").hidden = true;
    $("finish-button").hidden = true;
    (async () => {
      const { ok, data } = await api("/api/auth/peek", { token: signinToken });
      if (!ok) {
        $("finish-text").textContent = message(data, "That sign-in link is not valid.");
        return;
      }
      $("finish-text").textContent = `This link signs you in as ${data.email}. Only continue if that is your email address.`;
      if (data.signedInAs) {
        $("finish-note").textContent = `You are signed in as ${data.signedInAs} now. Continuing switches you to ${data.email}.`;
        $("finish-note").hidden = false;
      }
      const b = $<HTMLButtonElement>("finish-button");
      b.textContent = `Sign in as ${data.email}`;
      b.hidden = false;
      b.disabled = false;
      // onclick, not a listener, so a second link replaces the first.
      b.onclick = async () => {
        b.disabled = true;
        b.onclick = null;
        const res = await api("/api/auth/verify", { token: signinToken, email: data.email });
        $("finish").hidden = true;
        await loadMe();
        if (!res.ok) return say(message(res.data, "Could not sign in."), "error");
        const pending = store.get(PENDING_KEY);
        if (pending && !urlInput.value) urlInput.value = pending;
        say(urlInput.value ? `You're signed in. Press Run Audit to check ${urlInput.value}.` : "You're signed in. Enter a page to audit.", "ok");
        urlInput.focus();
      };
    })();
  }
  handleSigninLink();
  window.addEventListener("hashchange", handleSigninLink);

  if (new URLSearchParams(location.search).get("paid") === "1") {
    history.replaceState(null, "", location.pathname);
    say("Thanks. Your plan turns on as soon as the payment is confirmed.", "ok");
    let tries = 0;
    const poll = setInterval(async () => {
      await loadMe();
      if (state.user?.plan === "pro" || ++tries > 10) {
        clearInterval(poll);
        if (state.user?.plan === "pro") say("Your $5 plan is on. You have 20 full audits this month.", "ok");
      }
    }, 3000);
  }

  $("watch-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const { ok, data } = await api("/api/watch", { url: $<HTMLInputElement>("watch-url").value.trim() });
    const later = ok && data.nextCheckAt > Date.now() + 3_600_000 ? ` First check on ${new Date(data.nextCheckAt).toISOString().slice(0, 10)}.` : "";
    $("watch-status").textContent = ok ? (data.watchUrl ? `Checking ${data.watchUrl} every week.${later}` : "No site saved.") : message(data, "Could not save.");
  });

  $("watch-clear").addEventListener("click", async () => {
    const { ok } = await api("/api/watch", { url: null });
    if (ok) {
      $<HTMLInputElement>("watch-url").value = "";
      $("watch-status").textContent = "Weekly check stopped.";
    }
  });

  $("audit-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const url = urlInput.value.trim();
    if (!url) {
      say("Enter the address of the page you want audited, like yourbusiness.com.", "error");
      return urlInput.focus();
    }
    if (!state.user) {
      store.set(PENDING_KEY, url);
      say("Enter your email below first. Your first audit is free.");
      return $("email").focus();
    }
    runButton.disabled = true;
    runButton.textContent = "Auditing…";
    reportEl.hidden = true;
    $("working").hidden = false;
    say(`Checking ${url} and up to four pages it links to. This can take up to a minute.`);
    const { ok, data } = await api("/api/audit", { url, turnstileToken: takeHumanToken("audit") });
    runButton.disabled = false;
    runButton.textContent = "Run Audit";
    $("working").hidden = true;
    if (!ok) {
      say(message(data, "The audit failed."), "error");
      if (data.upgrade && state.billingEnabled) $("upgrade").hidden = false;
      return;
    }
    store.set(PENDING_KEY, null);
    say("");
    renderReport(data.report);
    reportEl.focus({ preventScroll: true });
    reportEl.scrollIntoView({ behavior: "smooth", block: "start" });
    await loadMe();
  });

  const pending = store.get(PENDING_KEY);
  if (pending) urlInput.value = pending;
  loadMe();
}
