# Dictate

A free Wispr Flow alternative for your Mac. Hold a hotkey, talk, let go, and your words are typed wherever your cursor is: email, Slack, Google Docs, your code editor, anything.

- **Free and private.** Speech-to-text runs on your Mac with [whisper.cpp](https://github.com/ggml-org/whisper.cpp) on the Apple Silicon GPU. No account, no subscription, works offline.
- **Clean text.** "Um" and "uh" are removed locally. An optional AI pass (Groq or Google Gemini, both have free tiers) also fixes punctuation, false starts and "no wait, I mean…". It's off until you add a key, and only the text is sent, never your voice.
- **Your words.** A word list teaches it names like Allum and Floorjack.
- **History.** Your recent dictations, with a Copy button, in case a paste lands in the wrong place.

It lives in the menu bar (the microphone icon). There's no Dock icon.

## Install and run

You need an Apple Silicon Mac (an Intel Mac works, just slower) and about 2 GB of free disk space.

**1. Prerequisites (one time).** In Terminal:

```bash
xcode-select --install                                           # Apple's command-line tools
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # Rust (press Enter for the defaults)
brew install node cmake                                          # Node.js and CMake (needs Homebrew: https://brew.sh)
```

Skip any you already have. Open a new Terminal window afterwards so Rust is on your PATH.

**2. Get the code and build.**

```bash
git clone https://github.com/allumstrat/claudes-desk.git
cd claudes-desk
git checkout claude/project-thread-rvgmjs   # until this is merged
cd wispr-alt
./run-mac.sh
```

The first build compiles whisper.cpp and takes a few minutes. The script checks the prerequisites, builds `Dictate.app`, copies it to `~/Applications`, and opens it. Run `./run-mac.sh --check` to only check prerequisites.

**3. First-run setup.** The Dictate window opens on its own the first time:

1. **Speech model.** Click Download. The recommended model (Large v3 Turbo, compressed) is about 570 MB and downloads once.
2. **Microphone.** Click Test microphone. macOS asks for microphone access; click Allow. If it never asks, click Open Microphone settings and turn on Dictate.
3. **Paste permission.** Click Allow paste. macOS opens Privacy & Security → Accessibility; turn on Dictate. Without this, Dictate still works but leaves the text on your clipboard for you to paste with ⌘V.
4. **Try it.** Click in the Try it box, hold **⌥ Space** (Option + Space), say something, and let go.

After that you can close the window; Dictate keeps running in the menu bar. Click the menu bar icon → Open Dictate… to get back to it, or Quit Dictate to stop it.

To start Dictate when you log in: System Settings → General → Login Items → add Dictate from `~/Applications`.

## Using it

| | |
|---|---|
| Dictate | Hold ⌥ Space, talk, let go. The menu bar shows **● REC** while listening and **…** while transcribing. |
| Toggle mode | Settings → "Press to start, press again to stop" if you'd rather not hold the keys. |
| Change the hotkey | Settings → Hotkey → Change, then press the new combination. It needs a modifier (⌘ ⌥ ⌃ ⇧) or an F-key. |
| Teach a word | Words tab. One per line. `Floorjack` teaches the spelling; `floor jack -> Floorjack` also fixes what Whisper keeps mishearing. |
| AI cleanup | Settings → AI cleanup → pick Groq or Gemini → Get a free key → paste it → Save key → Test cleanup. The key is stored in your macOS Keychain. |
| Find an old dictation | History tab → Copy. |

**Which model?** Large v3 Turbo (compressed) is the default and the best balance on Apple Silicon. Base (English) is the fastest if your Mac is older. Switch in Setup; each model downloads once and lives in `~/Library/Application Support/com.allumstrategies.dictate/models`.

**Free AI keys.** Groq: https://console.groq.com/keys (default model `llama-3.3-70b-versatile`). Gemini: https://aistudio.google.com/apikey (default model `gemini-2.5-flash-lite`). Free-tier model names change now and then; if Test cleanup says a model isn't found, put a current one from the provider's model list in the Model box. If the AI pass fails for any reason, Dictate pastes the locally cleaned text instead, and the History entry says why.

## Troubleshooting

- **Text goes to the clipboard but isn't pasted.** Accessibility isn't on for this copy of Dictate. Open System Settings → Privacy & Security → Accessibility, remove Dictate with the − button if it's listed, then click Allow paste in Dictate again.
- **"Didn't hear anything".** Microphone access is off, or the wrong input is selected. Check System Settings → Privacy & Security → Microphone, and Settings → Microphone in Dictate.
- **After rebuilding, permissions stopped working.** Every build has a new signature, so macOS treats it as a new app. `run-mac.sh` resets the old approvals when it replaces an installed copy; just allow them again.
- **The hotkey does nothing.** Another app may own that shortcut (ChatGPT's desktop app also uses ⌥ Space). Pick another one in Settings.
- **Keychain asks for permission after a rebuild.** Click Always Allow; same signature reason as above.

## Developing

```bash
./run-mac.sh --dev                   # run from source with live reload
cargo test -p dictate-core           # core tests (runs on any OS)
```

The command-line tool checks transcription without the app, the hotkey or any permissions:

```bash
cargo run --release -p dictate-core --bin dictate-cli -- download base.en
cargo run --release -p dictate-core --features metal --bin dictate-cli -- transcribe samples/jfk.wav --model base.en --words "Allum,Floorjack"
DICTATE_TEST_MODEL=~/Library/Application\ Support/com.allumstrategies.dictate/models/ggml-base.en.bin \
  cargo test --release -p dictate-core --features metal --test whisper -- --nocapture
```

Layout:

```
core/         dictate-core: audio prep, model download, Whisper, cleanup, word list, history, settings
  src/bin/    dictate-cli
src-tauri/    the menu bar app: hotkey, microphone, paste, permissions, tray, commands
  src/platform/macos.rs   paste via ⌘V keystroke, Accessibility check, System Settings links
ui/           the settings window (plain HTML/JS, no build step)
run-mac.sh    build + install script
```

## What isn't supported yet

- The Fn key or a single modifier (like Right ⌥ alone) as the hotkey. macOS only lets apps register those through a lower-level keyboard hook; it's a possible next step.
- Streaming text while you talk. Text appears after you let go (usually within a second or two on Apple Silicon).
- A floating on-screen recording indicator. For now the menu bar shows the state, and short sounds play on start and stop (turn them off in Settings).
