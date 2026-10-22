// OmniVoice Podcast front end. Plain JS, no build step.
const $ = (s, el = document) => el.querySelector(s);
const SR = 24000;          // OmniVoice works at 24 kHz
const MAX_CLIP_S = 15;     // trim long clips; 3 to 10 s is the sweet spot

const store = {
  get(k, d = "") { try { return localStorage.getItem("ovp." + k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("ovp." + k, v); } catch {} },
};

async function api(path, body, method) {
  const opts = { method: method || (body ? "POST" : "GET"), headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  const res = await fetch(path, opts);
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data.error || data.detail?.[0]?.msg || `Request failed (${res.status})`);
  return data;
}

function say(el, text, kind = "") { el.textContent = text; el.className = "msg " + kind; }

async function busy(btn, fn) {
  btn.disabled = true;
  try { return await fn(); } finally { btn.disabled = false; }
}

// ---------- audio: any clip -> mono 24 kHz 16-bit WAV, in the browser ----------

async function toWav(blob) {
  const buf = await blob.arrayBuffer();
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const decoded = await ctx.decodeAudioData(buf);
  ctx.close();
  const seconds = Math.min(decoded.duration, MAX_CLIP_S);
  const off = new OfflineAudioContext(1, Math.ceil(seconds * SR), SR);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start(0);
  const rendered = await off.startRendering();
  return { wav: encodeWav(rendered.getChannelData(0), SR), seconds, trimmed: decoded.duration > MAX_CLIP_S };
}

function encodeWav(samples, rate) {
  const out = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const w = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); out.setUint32(4, 36 + samples.length * 2, true); w(8, "WAVE");
  w(12, "fmt "); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, rate, true); out.setUint32(28, rate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
  w(36, "data"); out.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([out], { type: "audio/wav" });
}

// ---------- status ----------

let statusTimer;
async function refreshStatus() {
  const el = $("#status");
  try {
    const s = await api("/api/status");
    let text, kind;
    if (s.engine === "stub") { text = "Test mode: tones instead of real voices (started with --stub)."; kind = "warn"; }
    else if (s.state === "ready") { text = `OmniVoice ${s.omnivoice_version || ""} is ready on ${s.device}.`; kind = "ok"; }
    else if (s.state === "loading") { text = `Loading OmniVoice on ${s.device}… The first run downloads the model, so this can take a few minutes.`; kind = "warn"; }
    else if (s.state === "error") { text = `OmniVoice didn't load: ${s.error}`; kind = "bad"; }
    else { text = `OmniVoice: ${s.state}`; kind = "warn"; }
    if (!s.ffmpeg) text += " Episodes save as WAV (install ffmpeg for MP3 too).";
    el.textContent = text;
    el.className = "status " + kind;
    clearTimeout(statusTimer);
    if (s.state === "loading") statusTimer = setTimeout(refreshStatus, 3000);
    return s;
  } catch (e) {
    el.textContent = "Can't reach the local server. Is ./run.sh still running?";
    el.className = "status bad";
  }
}

// ---------- voices ----------

function setupVoice(card, saved) {
  const role = card.dataset.role;
  const nameEl = $(".v-name", card), tEl = $(".v-transcript", card), msg = $(".v-msg", card);
  const player = $(".v-audio", card), timer = $(".v-timer", card), recBtn = $(".v-rec", card);
  let pending = null; // a new clip (WAV blob) not saved yet
  let recorder = null, chunks = [], tick = null;

  if (saved) {
    nameEl.value = saved.name || nameEl.value;
    tEl.value = saved.transcript || "";
    player.src = saved.url; player.hidden = false;
    say(msg, `Saved clip, ${saved.seconds}s`, "ok");
  }

  async function useClip(blob) {
    try {
      const { wav, seconds, trimmed } = await toWav(blob);
      pending = wav;
      player.src = URL.createObjectURL(wav); player.hidden = false;
      const note = seconds < 3 ? " That's short; 5 to 10 seconds clones better." : trimmed ? ` Trimmed to ${MAX_CLIP_S}s.` : "";
      say(msg, `New clip, ${seconds.toFixed(1)}s. Click Save voice.${note}`, seconds < 3 ? "bad" : "");
    } catch (e) {
      say(msg, "Couldn't read that audio. Try a WAV, MP3 or M4A file.", "bad");
    }
  }

  recBtn.onclick = async () => {
    if (recorder) { recorder.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false } });
      chunks = [];
      recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        clearInterval(tick); timer.textContent = "";
        recBtn.textContent = "Record"; recBtn.classList.remove("recording");
        recorder = null;
        await useClip(new Blob(chunks, { type: chunks[0]?.type || "audio/webm" }));
      };
      recorder.start();
      const t0 = Date.now();
      recBtn.textContent = "Stop"; recBtn.classList.add("recording");
      tick = setInterval(() => {
        const s = (Date.now() - t0) / 1000;
        timer.textContent = `${s.toFixed(0)}s`;
        if (s >= 12 && recorder) recorder.stop();
      }, 250);
    } catch (e) {
      say(msg, "The browser couldn't use the microphone. Allow it, or upload a clip.", "bad");
    }
  };

  $(".v-file", card).onchange = (e) => e.target.files[0] && useClip(e.target.files[0]);
  $(".v-use-ref", card).onclick = () => { tEl.value = $("#refSentence").textContent.trim(); };

  $(".v-save", card).onclick = (e) => busy(e.target, async () => {
    try {
      let saved;
      if (pending) {
        const fd = new FormData();
        fd.append("file", pending, `${role}.wav`);
        fd.append("name", nameEl.value);
        fd.append("transcript", tEl.value);
        saved = await api(`/api/voices/${role}`, fd);
        pending = null;
        player.src = saved.url;
      } else {
        saved = await api(`/api/voices/${role}`, { name: nameEl.value, transcript: tEl.value }, "PATCH");
      }
      say(msg, `Saved, ${saved.seconds}s clip`, "ok");
      updateScriptInfo();
    } catch (err) { say(msg, err.message, "bad"); }
  });

  $(".v-test", card).onclick = (e) => busy(e.target, async () => {
    say(msg, "Generating a test line…");
    try {
      const r = await api(`/api/voices/${role}/test`, {});
      const a = $(".v-test-audio", card);
      a.src = r.url; a.hidden = false; a.play().catch(() => {});
      say(msg, "Test line ready", "ok");
    } catch (err) { say(msg, err.message, "bad"); }
  });

  nameEl.addEventListener("input", updateScriptInfo);
}

const names = () => ({
  host_name: $('.voice[data-role="host"] .v-name').value.trim() || "Host",
  guest_name: $('.voice[data-role="guest"] .v-name').value.trim() || "Guest",
});

// ---------- interview ----------

function questions() { return $("#questions").value.split("\n").map((q) => q.trim()).filter(Boolean); }
function answers() { return [...document.querySelectorAll("#answers textarea")].map((t) => t.value.trim()); }

function renderAnswers() {
  const prev = answers();
  const box = $("#answers");
  box.innerHTML = "";
  questions().forEach((q, i) => {
    const div = document.createElement("div");
    div.className = "answer";
    div.innerHTML = `<div class="q"></div><textarea rows="3"></textarea>`;
    $(".q", div).textContent = `${i + 1}. ${q}`;
    $("textarea", div).value = prev[i] || store.get("a" + i);
    $("textarea", div).addEventListener("input", (e) => store.set("a" + i, e.target.value));
    box.appendChild(div);
  });
  if (!questions().length) box.innerHTML = `<p class="hint">Questions you add above show up here.</p>`;
}

function interviewBody() {
  return {
    show_name: $("#showName").value.trim() || "the show",
    ...names(),
    guest_bio: $("#guestBio").value.trim(),
    topic: $("#topic").value.trim(),
    count: Number($("#qCount").value) || 6,
    questions: questions(),
    answers: answers(),
    api_key: $("#apiKey").value.trim() || null,
  };
}

function guestPacket() {
  const { host_name, guest_name } = names();
  const qs = questions().map((q, i) => `${i + 1}. ${q}`).join("\n");
  return `Hi ${guest_name === "Guest" ? "there" : guest_name.split(" ")[0]},

Thanks for doing the podcast. Here's how it works: you answer the questions below in writing, and send me a short voice clip. I use an AI voice model to clone your voice from the clip so it can read your answers aloud in the episode. Please only send the clip if you're OK with that.

1. Reply with your answers to these questions (a few sentences each is perfect):

${qs}

2. Record 5 to 10 seconds of yourself reading this, in a quiet room, phone close to your mouth:

"${$("#refSentence").textContent.trim()}"

Send it as a voice memo or audio file.

Thanks!
${host_name}`;
}

// ---------- script ----------

const SAMPLE = `HOST: Welcome to The Allum Hour. I'm Jacob, and today I'm talking with Maria, who runs a family auto repair shop in Phoenix.
GUEST: Thanks for having me, Jacob. I'm glad to be here.
HOST: Let's start at the beginning. How did you end up running the shop?
GUEST: My dad opened it in nineteen ninety eight. I grew up doing homework in the waiting room, and when he retired I couldn't picture anyone else taking it over.
HOST: That's a great story. What changed the most when you took over?
GUEST: Honestly, how people find us. It used to be the sign out front and word of mouth. Now almost every new customer finds us on Google first.
HOST: So what's one thing that actually moved the needle for you there?
GUEST: Asking every happy customer for a review, right at the counter. We went from forty reviews to over three hundred in about a year.
HOST: [laughter] That's a lot of asking. Last question. What's next for the shop?
GUEST: We're adding a second bay for electric vehicles. I think that's where the next ten years are going.
HOST: Maria, thanks so much for coming on. That's it for this episode of The Allum Hour. See you next time.`;

async function updateScriptInfo() {
  const info = $("#scriptInfo");
  const text = $("#script").value;
  store.set("script", text);
  if (!text.trim()) { info.textContent = ""; return null; }
  try {
    const { turns } = await api("/api/script/parse", { text, ...names() });
    const words = turns.reduce((n, t) => n + t.text.split(/\s+/).length, 0);
    const h = turns.filter((t) => t.speaker === "host").length;
    info.textContent = `${turns.length} lines (${h} host, ${turns.length - h} guest), about ${Math.max(1, Math.round(words / 150))} min of audio.`;
    info.className = "hint";
    return turns;
  } catch (e) {
    info.textContent = e.message; info.className = "msg bad";
    return null;
  }
}

// ---------- render ----------

async function pollJob(id) {
  const bar = $("#bar"), txt = $("#progressText");
  for (;;) {
    const j = await api(`/api/jobs/${id}`);
    bar.max = j.total; bar.value = j.done;
    txt.textContent = j.status === "running" || j.status === "queued"
      ? `Line ${Math.min(j.done + 1, j.total)} of ${j.total} · ${j.elapsed}s · ${j.current}`
      : `${j.done} of ${j.total} lines in ${j.elapsed}s`;
    if (j.status === "done" || j.status === "error") return j;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function loadPast() {
  try {
    const { episodes } = await api("/api/episodes");
    $("#past").innerHTML = episodes.length ? "" : "<li class='hint'>None yet</li>";
    episodes.forEach((e) => {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = e.wav; a.textContent = `${e.id} (${e.seconds}s)`; a.download = `episode-${e.id}.wav`;
      li.appendChild(a); $("#past").appendChild(li);
    });
  } catch {}
}

// ---------- wire up ----------

async function init() {
  const s = await refreshStatus();
  document.querySelectorAll(".voice").forEach((card) => setupVoice(card, s?.voices?.[card.dataset.role]));

  for (const id of ["showName", "topic", "guestBio", "questions"]) {
    const el = $("#" + id);
    el.value = store.get(id, el.value);
    el.addEventListener("input", () => store.set(id, el.value));
  }
  $("#apiKey").value = store.get("apiKey");
  $("#apiKey").addEventListener("input", (e) => store.set("apiKey", e.target.value));
  $("#script").value = store.get("script");
  $("#questions").addEventListener("input", renderAnswers);
  renderAnswers();
  updateScriptInfo();
  let t; $("#script").addEventListener("input", () => { clearTimeout(t); t = setTimeout(updateScriptInfo, 400); });

  $("#writeQuestions").onclick = (e) => busy(e.target, async () => {
    say($("#qMsg"), "Claude is writing questions…");
    try {
      const { questions: qs } = await api("/api/claude/questions", interviewBody());
      $("#questions").value = qs.join("\n"); store.set("questions", $("#questions").value);
      renderAnswers();
      say($("#qMsg"), `${qs.length} questions ready. Edit them, then copy the note for your guest.`, "ok");
    } catch (err) { say($("#qMsg"), err.message, "bad"); }
  });

  $("#copyPacket").onclick = async () => {
    if (!questions().length) return say($("#packetMsg"), "Add questions first", "bad");
    try { await navigator.clipboard.writeText(guestPacket()); say($("#packetMsg"), "Copied. Paste it into a text or email to your guest.", "ok"); }
    catch { say($("#packetMsg"), "Couldn't copy. Your browser blocked the clipboard.", "bad"); }
  };

  $("#writeScript").onclick = (e) => busy(e.target, async () => {
    say($("#sMsg"), "Claude is writing the script…");
    try {
      const r = await api("/api/claude/script", interviewBody());
      $("#script").value = r.text; await updateScriptInfo();
      say($("#sMsg"), r.title ? `Script ready: ${r.title}` : "Script ready", "ok");
    } catch (err) { say($("#sMsg"), err.message, "bad"); }
  });

  $("#simpleScript").onclick = (e) => busy(e.target, async () => {
    try {
      const r = await api("/api/script/simple", interviewBody());
      $("#script").value = r.text; await updateScriptInfo();
      say($("#sMsg"), "Built from the questions and answers, word for word.", "ok");
    } catch (err) { say($("#sMsg"), err.message, "bad"); }
  });

  $("#sampleScript").onclick = () => { $("#script").value = SAMPLE; updateScriptInfo(); say($("#sMsg"), "Sample loaded"); };

  $("#render").onclick = (e) => busy(e.target, async () => {
    const rMsg = $("#rMsg");
    const turns = await updateScriptInfo();
    if (!turns) return say(rMsg, "Fix the script first", "bad");
    say(rMsg, "");
    $("#result").hidden = true; $("#progress").hidden = false;
    try {
      const job = await api("/api/render", {
        turns,
        num_step: Number($("#numStep").value),
        gap_ms: Number($("#gapMs").value),
        speed: Number($("#speed").value) || 1,
      });
      const done = await pollJob(job.id);
      if (done.status === "error") throw new Error(done.error);
      $("#episode").src = done.files.wav;
      const dl = $("#downloads"); dl.innerHTML = "";
      for (const [kind, url] of Object.entries(done.files)) {
        const a = document.createElement("a");
        a.href = url; a.download = `episode-${done.id}.${kind}`; a.textContent = `Download ${kind.toUpperCase()}`;
        a.className = "file"; dl.appendChild(a);
      }
      $("#result").hidden = false;
      say(rMsg, `Done: ${done.duration}s episode`, "ok");
      loadPast();
    } catch (err) { say(rMsg, err.message, "bad"); }
  });

  loadPast();
}

init();
