// Dictate settings window. Plain JS on purpose: no build step.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (id) => document.getElementById(id);
let state = null;
let downloading = null;

// ------------------------------------------------------------ helpers

function prettyHotkey(hk) {
  return hk.split("+").map((p) => {
    const k = p.trim().toLowerCase();
    if (k === "alt" || k === "option") return "⌥";
    if (k === "shift") return "⇧";
    if (k === "control" || k === "ctrl") return "⌃";
    if (["super", "cmd", "command", "meta", "commandorcontrol", "cmdorctrl"].includes(k)) return "⌘";
    return p.trim().replace(/^Key/, "").replace(/^Digit/, "");
  }).join("");
}

function hotkeyAction(s) {
  const hk = prettyHotkey(s.hotkey);
  return s.mode === "hold" ? `hold ${hk} and talk, then let go` : `press ${hk}, talk, and press it again`;
}

function showNotice(text) {
  if (!text) { $("notice").hidden = true; return; }
  $("notice-text").textContent = text;
  $("notice").hidden = false;
}

function flash(el, text) {
  el.textContent = text;
  clearTimeout(el._t);
  el._t = setTimeout(() => (el.textContent = ""), 2500);
}

function fmtMB(bytes) { return Math.round(bytes / 1e6); }

function timeAgo(secs) {
  const d = Date.now() / 1000 - secs;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  return new Date(secs * 1000).toLocaleString();
}

// ------------------------------------------------------------ render

function render() {
  const s = state.settings;
  const model = state.models.find((m) => m.id === s.model);
  const ready = model && model.downloaded;

  $("hint").textContent = ready
    ? `In any app, ${hotkeyAction(s)}.`
    : "Finish setup below to start dictating.";
  document.querySelectorAll(".hotkey-label").forEach((el) => (el.textContent = hotkeyAction(s)));
  setPhase(state.phase);
  showNotice(state.last_error);

  // Setup: model
  const sel = $("model");
  sel.innerHTML = "";
  for (const m of state.models) {
    const o = document.createElement("option");
    o.value = m.id;
    o.textContent = `${m.label} · ${m.size_mb >= 1000 ? (m.size_mb / 1000).toFixed(1) + " GB" : m.size_mb + " MB"}${m.downloaded ? " ✓" : ""}`;
    sel.appendChild(o);
  }
  sel.value = s.model;
  const selModel = state.models.find((m) => m.id === sel.value);
  $("download").textContent = selModel && selModel.downloaded ? "Downloaded" : "Download";
  $("download").disabled = !!downloading || (selModel && selModel.downloaded);
  $("cancel-download").hidden = !downloading;
  $("progress").hidden = !downloading;
  if (!downloading) {
    $("model-status").textContent = ready
      ? "Ready. Models are stored in " + state.models_dir
      : "Download the model to start. The recommended one is about 570 MB.";
  }
  $("step-model").classList.toggle("done", !!ready);

  // Setup: accessibility
  $("ax-status").textContent = state.accessibility
    ? "Allowed. Dictate can paste for you."
    : "Not allowed yet. Click Allow paste, then turn on Dictate in the list macOS opens.";
  $("step-ax").classList.toggle("done", state.accessibility);
  $("allow-ax").disabled = state.accessibility;

  // Settings
  $("hotkey").value = prettyHotkey(s.hotkey);
  document.querySelectorAll('input[name="mode"]').forEach((r) => (r.checked = r.value === s.mode));
  $("language").value = s.language;
  const mic = $("microphone");
  mic.innerHTML = '<option value="">System default</option>';
  for (const name of state.microphones) {
    const o = document.createElement("option");
    o.value = o.textContent = name;
    mic.appendChild(o);
  }
  mic.value = s.microphone || "";
  for (const k of ["remove_fillers", "restore_clipboard", "sounds"]) $(k).checked = s[k];
  $("cleanup").value = s.cleanup;
  renderCleanup();

  // Words
  if (document.activeElement !== $("words")) $("words").value = s.words.join("\n");

  renderHistory(state.history);
  $("footer").textContent = `Dictate ${state.version} · free and local`;
}

function renderCleanup() {
  const s = state.settings;
  const p = $("cleanup").value;
  $("cleanup-config").hidden = p === "off";
  if (p === "off") return;
  const has = state.has_key[p];
  $("key-status").textContent = has ? "Key saved in your Keychain." : "No key saved yet.";
  $("api-key").placeholder = has ? "Saved. Paste a new key to replace it" : "Paste your key";
  $("cleanup-model").value = p === "groq" ? s.groq_model : s.gemini_model;
  $("get-key").textContent = p === "groq" ? "Get a free Groq key" : "Get a free Gemini key";
}

function renderHistory(entries) {
  const ul = $("history");
  ul.innerHTML = "";
  if (!entries.length) {
    ul.innerHTML = '<li class="muted">Nothing yet.</li>';
    return;
  }
  for (const e of entries) {
    const li = document.createElement("li");
    const text = document.createElement("p");
    text.textContent = e.text;
    const meta = document.createElement("div");
    meta.className = "row spread small muted";
    const info = document.createElement("span");
    info.textContent = `${timeAgo(e.at)} · ${(e.audio_ms / 1000).toFixed(1)} s of audio · ready in ${(e.took_ms / 1000).toFixed(1)} s`;
    const copy = document.createElement("button");
    copy.className = "link";
    copy.textContent = "Copy";
    copy.onclick = async () => { await invoke("copy_text", { text: e.text }); flash(copy, "Copied"); setTimeout(() => (copy.textContent = "Copy"), 1500); };
    meta.append(info, copy);
    li.append(text, meta);
    if (e.note) {
      const n = document.createElement("p");
      n.className = "small muted";
      n.textContent = e.note;
      li.appendChild(n);
    }
    if (e.raw && e.raw.trim() !== e.text.trim()) {
      const d = document.createElement("details");
      d.innerHTML = "<summary class='small muted'>What Whisper heard</summary>";
      const p = document.createElement("p");
      p.className = "small muted";
      p.textContent = e.raw;
      d.appendChild(p);
      li.appendChild(d);
    }
    ul.appendChild(li);
  }
}

function setPhase(phase) {
  const el = $("phase");
  const ready = state && state.models.find((m) => m.id === state.settings.model)?.downloaded;
  const labels = { idle: ready ? "Ready" : "Needs setup", recording: "Listening", transcribing: "Transcribing" };
  el.textContent = labels[phase] || phase;
  el.className = "pill " + (phase === "idle" && !ready ? "warn" : phase);
}

// ------------------------------------------------------------ actions

async function refresh() {
  state = await invoke("get_state");
  downloading = state.downloading;
  render();
}

async function save(patch) {
  const next = { ...state.settings, ...patch };
  try {
    await invoke("save_settings", { settings: next });
    state.settings = next;
    flash($("saved"), "Saved");
    render();
  } catch (e) {
    showNotice(String(e));
    render();
  }
}

document.querySelectorAll("nav button").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll("nav button").forEach((x) => x.classList.toggle("active", x === b));
    document.querySelectorAll(".tab").forEach((t) => (t.hidden = t.id !== "tab-" + b.dataset.tab));
    if (b.dataset.tab === "setup") refresh();
  };
});

$("notice-close").onclick = async () => { await invoke("dismiss_notice"); showNotice(null); };

$("model").onchange = () => save({ model: $("model").value });
$("download").onclick = async () => {
  try {
    await invoke("download_model", { id: $("model").value });
    downloading = $("model").value;
    $("progress").value = 0;
    $("model-status").textContent = "Starting download…";
    render();
  } catch (e) { showNotice(String(e)); }
};
$("cancel-download").onclick = () => invoke("cancel_download");

$("test-mic").onclick = async () => {
  $("test-mic").disabled = true;
  $("mic-status").textContent = "Say something for a second…";
  try {
    const r = await invoke("test_microphone");
    const ok = r.peak > 0.02;
    $("mic-status").textContent = ok
      ? `Working. Heard you on “${r.device}”.`
      : `Got silence from “${r.device}”. If macOS didn't ask for permission, open Microphone settings and turn on Dictate.`;
    $("step-mic").classList.toggle("done", ok);
  } catch (e) {
    $("mic-status").textContent = String(e);
  }
  $("test-mic").disabled = false;
};
$("open-mic").onclick = () => invoke("open_settings_pane", { pane: "microphone" });
$("allow-ax").onclick = async () => { await invoke("request_accessibility"); setTimeout(refresh, 1500); };
$("recheck").onclick = refresh;

// Hotkey capture: press the combination you want.
$("record-hotkey").onclick = () => {
  const input = $("hotkey");
  input.value = "Press the keys…";
  input.focus();
  const onKey = (e) => {
    e.preventDefault();
    if (["Meta", "Alt", "Shift", "Control"].includes(e.key)) return;
    window.removeEventListener("keydown", onKey, true);
    if (e.key === "Escape") { render(); return; }
    const mods = [];
    if (e.metaKey) mods.push("Super");
    if (e.ctrlKey) mods.push("Control");
    if (e.altKey) mods.push("Alt");
    if (e.shiftKey) mods.push("Shift");
    const isF = /^F\d{1,2}$/.test(e.code);
    if (!mods.length && !isF) {
      showNotice("Use at least one modifier key (⌘ ⌥ ⌃ ⇧), or an F-key.");
      render();
      return;
    }
    save({ hotkey: [...mods, e.code].join("+") });
  };
  window.addEventListener("keydown", onKey, true);
};

document.querySelectorAll('input[name="mode"]').forEach((r) => (r.onchange = () => save({ mode: r.value })));
$("language").onchange = () => save({ language: $("language").value });
$("microphone").onchange = () => save({ microphone: $("microphone").value || null });
for (const k of ["remove_fillers", "restore_clipboard", "sounds"]) $(k).onchange = () => save({ [k]: $(k).checked });

$("cleanup").onchange = () => save({ cleanup: $("cleanup").value });
$("cleanup-model").onchange = () => {
  const v = $("cleanup-model").value.trim();
  if (!v) return render();
  save($("cleanup").value === "groq" ? { groq_model: v } : { gemini_model: v });
};
$("save-key").onclick = async () => {
  try {
    await invoke("set_api_key", { provider: $("cleanup").value, key: $("api-key").value });
    $("api-key").value = "";
    await refresh();
    flash($("cleanup-result"), "Key saved.");
  } catch (e) { $("cleanup-result").textContent = String(e); }
};
$("get-key").onclick = () => invoke("open_key_page", { provider: $("cleanup").value });
$("test-cleanup").onclick = async () => {
  $("cleanup-result").textContent = "Testing…";
  try {
    const out = await invoke("test_cleanup");
    $("cleanup-result").textContent = "Works: " + out;
  } catch (e) {
    $("cleanup-result").textContent = String(e);
  }
};

$("save-words").onclick = async () => {
  const words = $("words").value.split("\n").map((l) => l.trim()).filter(Boolean);
  await save({ words });
  flash($("words-saved"), "Saved");
};

$("clear-history").onclick = async () => { await invoke("clear_history"); state.history = []; renderHistory([]); };

// ------------------------------------------------------------ events

listen("status", (e) => { if (state) { state.phase = e.payload.phase; setPhase(e.payload.phase); } });
listen("notice", (e) => showNotice(e.payload));
listen("history", (e) => { if (state) { state.history = e.payload; renderHistory(e.payload); } });
listen("download", (e) => {
  const p = e.payload;
  if (p.error) {
    downloading = null;
    showNotice("Download failed: " + p.error);
    refresh();
  } else if (p.finished) {
    downloading = null;
    refresh();
  } else {
    downloading = p.id;
    $("progress").hidden = false;
    $("cancel-download").hidden = false;
    $("download").disabled = true;
    if (p.total) {
      $("progress").value = (p.done / p.total) * 100;
      $("model-status").textContent = `Downloading… ${fmtMB(p.done)} of ${fmtMB(p.total)} MB`;
    } else {
      $("model-status").textContent = `Downloading… ${fmtMB(p.done)} MB`;
    }
  }
});

// Permissions can change while the window is in the background.
window.addEventListener("focus", () => { if (state) refresh(); });

refresh();
