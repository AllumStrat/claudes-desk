#!/usr/bin/env bash
# Build Dictate and install it to ~/Applications.
#
#   ./run-mac.sh            build, install, open
#   ./run-mac.sh --dev      run straight from source with live reload (no install)
#   ./run-mac.sh --check    only check the prerequisites
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="Dictate"
BUNDLE_ID="com.allumstrategies.dictate"
INSTALL_DIR="$HOME/Applications"

say()  { printf '\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

if [[ "$(uname -s)" != "Darwin" ]]; then
  fail "Dictate's app is for macOS. (The core still builds anywhere: cargo test -p dictate-core)"
fi
if [[ "$(uname -m)" != "arm64" ]]; then
  say "Note: this Mac isn't Apple Silicon. Dictate will work, but transcription will be slower."
fi

missing=0
if ! xcode-select -p >/dev/null 2>&1; then
  echo "• Xcode Command Line Tools are missing. Install with:  xcode-select --install"; missing=1
fi
if ! command -v cargo >/dev/null 2>&1; then
  if [[ -x "$HOME/.cargo/bin/cargo" ]]; then
    export PATH="$HOME/.cargo/bin:$PATH"
  else
    echo "• Rust is missing. Install with:  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"; missing=1
  fi
fi
if ! command -v node >/dev/null 2>&1; then
  echo "• Node.js is missing. Install with:  brew install node   (or from nodejs.org)"; missing=1
fi
if ! command -v cmake >/dev/null 2>&1; then
  echo "• CMake is missing (whisper.cpp needs it). Install with:  brew install cmake"; missing=1
fi
if [[ $missing -ne 0 ]]; then
  fail "Install the items above, open a new Terminal window, then run ./run-mac.sh again."
fi
if command -v rustc >/dev/null 2>&1; then
  RUST_MINOR=$(rustc --version | awk '{print $2}' | cut -d. -f2)
  if [[ "${RUST_MINOR:-0}" -lt 90 ]]; then
    say "Updating Rust (Tauri needs 1.90 or newer)…"
    rustup update stable
  fi
fi
say "Prerequisites look good."
[[ "${1:-}" == "--check" ]] && exit 0

if [[ ! -d node_modules ]]; then
  say "Installing the Tauri command-line tool…"
  npm install --no-fund --no-audit
fi

if [[ "${1:-}" == "--dev" ]]; then
  say "Starting Dictate from source. Permissions you grant here belong to Terminal, not to the installed app."
  exec npx tauri dev
fi

say "Building Dictate (the first build compiles whisper.cpp and takes a few minutes)…"
npx tauri build

BUILT="target/release/bundle/macos/$APP_NAME.app"
[[ -d "$BUILT" ]] || fail "Build finished but $BUILT wasn't found."

mkdir -p "$INSTALL_DIR"
if [[ -d "$INSTALL_DIR/$APP_NAME.app" ]]; then
  say "Replacing the old copy…"
  osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
  sleep 1
  rm -rf "$INSTALL_DIR/$APP_NAME.app"
  # A rebuilt app has a new signature, so macOS's old Microphone and
  # Accessibility approvals no longer match it. Clear them so it asks again
  # instead of silently failing.
  tccutil reset Accessibility "$BUNDLE_ID" >/dev/null 2>&1 || true
  tccutil reset Microphone "$BUNDLE_ID" >/dev/null 2>&1 || true
  say "Permissions were reset for the new build; Dictate will ask for them again."
fi
cp -R "$BUILT" "$INSTALL_DIR/"
say "Installed to $INSTALL_DIR/$APP_NAME.app"
open "$INSTALL_DIR/$APP_NAME.app"
say "Dictate is running. Look for the microphone in your menu bar."
