# OmniVoice Podcast

A proof of concept for a fully AI-voiced interview podcast. Claude writes the interview questions, your guest answers them in writing and sends a short voice clip, and then your cloned voice and the guest's cloned voice perform the interview back and forth. Out comes one finished episode (WAV, plus MP3 if ffmpeg is installed).

It runs on your Mac and opens in your browser. Voice cloning is done locally by [OmniVoice](https://github.com/k2-fsa/OmniVoice) (k2-fsa), which clones a voice zero-shot from a 3 to 10 second clip.

Consent: only clone the voice of a guest who has agreed to have their voice cloned. The note the app writes for your guest says so.

## Run it

```bash
cd omnivoice-podcast
./run.sh
```

That opens http://127.0.0.1:8765. Stop it with Ctrl+C.

`run.sh` needs a Python where `import omnivoice` works. It picks, in order: `$PYTHON`, then `./.venv`, then `python3` on your PATH. So any of these work:

```bash
# 1. you already have OmniVoice in a conda env or venv: activate it first
conda activate omnivoice   # or: source ~/path/to/venv/bin/activate
./run.sh

# 2. or point straight at that env's Python
PYTHON=~/path/to/venv/bin/python ./run.sh

# 3. or let it make a fresh .venv here (torch 2.8 + omnivoice, a few GB)
./run.sh --setup

# Try the whole flow without OmniVoice (tones instead of voices)
./run.sh --stub
```

The first time OmniVoice loads it downloads the model from Hugging Face, which takes a few minutes. The banner at the top of the page shows when it's ready.

Quick check outside the web app:

```bash
python check_omnivoice.py              # installed? which device (mps on Apple Silicon)?
python check_omnivoice.py --generate   # loads the model, writes two-voice-check.wav with two designed voices
```

## How to make an episode

1. **Voices.** Record or upload a 5 to 10 second clip for you (host) and for the guest. Reading the sentence shown on the page means you know the exact transcript, which gives the best clone. Leave the transcript blank and OmniVoice will transcribe it with Whisper instead (that downloads Whisper the first time). Save each voice, then press Test voice to hear a sample line.
2. **Interview.** Fill in the show name, topic and a line about the guest. Press Write questions with Claude, or type your own (one per line). Copy the note for your guest: it has the questions, the clip instructions and the consent ask. Paste their written answers back under each question.
3. **Script.** Write script with Claude turns the Q&A into a natural back-and-forth. Claude is told to keep the guest's meaning and facts exactly and invent nothing for them, since it's their cloned voice. Build script without AI uses their answers word for word. Or paste any script:

   ```
   HOST: Welcome to the show.
   GUEST: Thanks for having me.
   ```

   Labels can be HOST/GUEST or the people's names. `[laughter]` and `[sigh]` work inside lines. Load sample script fills in a ready-made one.
4. **Make episode.** Each line is generated in the right voice, then stitched with a short pause between turns. Play it in the page or download it.

Everything is saved under `data/` (voice clips) and `output/<episode id>/` (`episode.wav`, `episode.mp3`, `script.txt`, and each line as its own WAV in `lines/`).

## Claude

Claude writing is optional. Paste an API key in the page (kept only in this browser), or start with `ANTHROPIC_API_KEY` set. It uses `claude-opus-5-5`; change it with `PODCAST_CLAUDE_MODEL`. Without a key, use Build script without AI or paste a script.

## Settings and troubleshooting

- Quality: Fast uses 16 diffusion steps, Standard uses 32 (OmniVoice's default). Fast is roughly twice as quick.
- If Apple GPU generation errors or sounds wrong, try `./run.sh --dtype float32`, or `--device cpu` (slow, but a good check).
- MP3 export needs ffmpeg (`brew install ffmpeg`). Without it you get WAV.
- Different port: `PORT=9000 ./run.sh`.
- Clips longer than 15 seconds are trimmed in the browser. Quiet room, phone close to the mouth, no music.

## Files

- `server.py`: local FastAPI server, loads OmniVoice in the same process
- `podcast/tts.py`: OmniVoice engine (`OmniVoice.from_pretrained`, `create_voice_clone_prompt`, `generate`), plus the test stub
- `podcast/jobs.py`, `podcast/audio.py`: line-by-line rendering and stitching
- `podcast/script.py`: script parsing and the no-AI script builder
- `podcast/writer.py`: Claude questions and script
- `static/`: the page
- `tests/`: `python -m pytest tests` (runs without OmniVoice)

## What has and hasn't been tested

Tested in a Linux cloud box with the stub engine: the server, voice upload, script parsing, the no-AI script builder, rendering and stitching an 11-line sample into a 67 second WAV and MP3, the clear error when there's no Claude key, the in-browser WAV encoder, and that the OmniVoice glue calls the API with the right arguments (checked against omnivoice 0.2.1's source).

Not tested yet, because they need your Mac: OmniVoice actually loading and cloning on Apple Silicon, recording from the microphone in the browser, and the Claude calls with a real key.
