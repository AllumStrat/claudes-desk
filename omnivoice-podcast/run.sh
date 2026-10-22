#!/usr/bin/env bash
# Start the OmniVoice Podcast app and open it in your browser.
#
#   ./run.sh            use the Python that has OmniVoice (see below for how it's picked)
#   ./run.sh --setup    make a fresh .venv here with torch + OmniVoice, then start
#   ./run.sh --stub     no OmniVoice: tones instead of voices, to try the flow
#
# Python is picked in this order: $PYTHON, ./.venv, then python3 on your PATH
# (so activating the conda/venv env where you installed OmniVoice works too).
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8765}"
STUB=0
SETUP=0
ARGS=()
for a in "$@"; do
  case "$a" in
    --setup) SETUP=1 ;;
    --stub) STUB=1; ARGS+=("$a") ;;
    *) ARGS+=("$a") ;;
  esac
done

if [[ $SETUP == 1 ]]; then
  BASE="${PYTHON:-python3}"
  if ! "$BASE" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'; then
    echo "OmniVoice needs Python 3.10 or newer; $BASE is $("$BASE" --version 2>&1)."
    echo "Install one (e.g. brew install python@3.12) and run: PYTHON=python3.12 ./run.sh --setup"
    exit 1
  fi
  echo "Making .venv with $("$BASE" --version)…"
  "$BASE" -m venv .venv
  .venv/bin/python -m pip install --upgrade pip
  .venv/bin/python -m pip install torch==2.8.0 torchaudio==2.8.0 omnivoice
  .venv/bin/python -m pip install -r requirements.txt
fi

if [[ -n "${PYTHON:-}" && $SETUP == 0 ]]; then PY="$PYTHON"
elif [[ -x .venv/bin/python ]]; then PY=".venv/bin/python"
else PY="python3"
fi

if [[ $STUB == 0 ]] && ! "$PY" -c "import omnivoice" 2>/dev/null; then
  cat <<EOF
OmniVoice isn't importable from $PY ($("$PY" --version 2>&1)).

Pick one:
  1. Activate the env where you installed OmniVoice, then ./run.sh again
     (or point at it:  PYTHON=/path/to/that/env/bin/python ./run.sh)
  2. ./run.sh --setup     installs torch + OmniVoice into ./.venv here
  3. ./run.sh --stub      try the app without real voices
EOF
  exit 1
fi

if ! "$PY" -c "import fastapi, uvicorn, soundfile, numpy, anthropic; import importlib.util as u; assert u.find_spec('python_multipart') or u.find_spec('multipart')" 2>/dev/null; then
  echo "Installing the web app's few extra packages into $PY…"
  "$PY" -m pip install -r requirements.txt
fi

export PYTORCH_ENABLE_MPS_FALLBACK=1
if command -v open >/dev/null 2>&1; then (sleep 2; open "http://127.0.0.1:$PORT") & fi
exec "$PY" server.py --port "$PORT" "${ARGS[@]+"${ARGS[@]}"}"
