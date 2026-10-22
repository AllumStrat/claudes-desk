"""Local web app: two cloned voices perform an interview, made with OmniVoice.

    python server.py            # real OmniVoice (loads the model in the background)
    python server.py --stub     # no OmniVoice: tones instead of speech, for testing the flow

Then open http://127.0.0.1:8765
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from pathlib import Path

import soundfile as sf
import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from podcast import audio, script, writer
from podcast.jobs import Renderer
from podcast.tts import OmniVoiceEngine, StubEngine

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
VOICES = DATA / "voices"
OUTPUT = ROOT / "output"
STATIC = ROOT / "static"

log = logging.getLogger("podcast")


# ---------- request bodies ----------


class ScriptText(BaseModel):
    text: str
    host_name: str = ""
    guest_name: str = ""


class Interview(BaseModel):
    show_name: str = "The Allum Hour"
    host_name: str = "Jacob"
    guest_name: str = "Guest"
    guest_bio: str = ""
    topic: str = ""
    count: int = Field(6, ge=1, le=15)
    questions: list[str] = []
    answers: list[str] = []
    api_key: str | None = None


class Turn(BaseModel):
    speaker: str
    text: str


class RenderRequest(BaseModel):
    turns: list[Turn]
    gap_ms: int = Field(350, ge=0, le=3000)
    num_step: int = Field(32, ge=4, le=64)
    speed: float = Field(1.0, ge=0.5, le=2.0)
    language: str = "en"


class TestVoice(BaseModel):
    text: str = "Hey, this is a quick test of my cloned voice for the podcast."
    num_step: int = Field(16, ge=4, le=64)


# ---------- app ----------


def create_app(engine) -> FastAPI:
    for d in (VOICES, OUTPUT):
        d.mkdir(parents=True, exist_ok=True)
    renderer = Renderer(engine, OUTPUT)
    app = FastAPI(title="OmniVoice Podcast")

    def voice_meta(role: str) -> dict | None:
        meta = VOICES / f"{role}.json"
        wav = VOICES / f"{role}.wav"
        if not (meta.exists() and wav.exists()):
            return None
        info = json.loads(meta.read_text())
        info.update(path=wav, url=f"/voices/{role}.wav?v={int(wav.stat().st_mtime)}")
        return info

    def public(info: dict | None) -> dict | None:
        return None if info is None else {k: v for k, v in info.items() if k != "path"}

    @app.get("/")
    def index():
        return FileResponse(STATIC / "index.html")

    @app.get("/api/status")
    def status():
        return {
            **engine.status(),
            "ffmpeg": audio.ffmpeg_available(),
            "claude_key_in_env": bool(os.environ.get("ANTHROPIC_API_KEY")),
            "claude_model": writer.MODEL,
            "python": sys.version.split()[0],
            "voices": {r: public(voice_meta(r)) for r in script.SPEAKERS},
        }

    @app.post("/api/model/load")
    def load_model():
        engine.start_loading()
        return engine.status()

    @app.post("/api/voices/{role}")
    async def upload_voice(role: str, file: UploadFile = File(...), name: str = Form(""), transcript: str = Form("")):
        if role not in script.SPEAKERS:
            raise HTTPException(404, "Voice must be host or guest")
        raw = await file.read()
        if not raw:
            raise HTTPException(400, "The clip is empty")
        tmp = VOICES / f"{role}.upload"
        tmp.write_bytes(raw)
        try:
            data, sr = sf.read(str(tmp), dtype="float32", always_2d=True)
        except Exception as e:  # noqa: BLE001
            tmp.unlink(missing_ok=True)
            raise HTTPException(400, f"Couldn't read that audio as WAV ({e}). The page converts clips for you; re-add it there.")
        seconds = len(data) / sr
        if seconds < 1.0:
            tmp.unlink(missing_ok=True)
            raise HTTPException(400, f"The clip is only {seconds:.1f}s. Record 5 to 10 seconds.")
        tmp.replace(VOICES / f"{role}.wav")
        info = {
            "role": role,
            "name": name.strip() or ("Host" if role == "host" else "Guest"),
            "transcript": transcript.strip(),
            "seconds": round(seconds, 1),
            "sample_rate": sr,
            "saved": time.strftime("%Y-%m-%d %H:%M:%S"),
        }
        (VOICES / f"{role}.json").write_text(json.dumps(info, indent=2))
        return public(voice_meta(role))

    @app.patch("/api/voices/{role}")
    def update_voice(role: str, body: dict):
        info = voice_meta(role)
        if info is None:
            raise HTTPException(404, "Add this voice's clip first")
        meta = json.loads((VOICES / f"{role}.json").read_text())
        for key in ("name", "transcript"):
            if key in body:
                meta[key] = str(body[key]).strip()
        (VOICES / f"{role}.json").write_text(json.dumps(meta, indent=2))
        return public(voice_meta(role))

    @app.post("/api/voices/{role}/test")
    def test_voice(role: str, body: TestVoice):
        info = voice_meta(role)
        if info is None:
            raise HTTPException(400, "Add this voice's clip first")
        try:
            seg = engine.generate(
                text=body.text, ref_audio=info["path"], ref_text=info.get("transcript") or None, num_step=body.num_step
            )
        except Exception as e:  # noqa: BLE001
            raise HTTPException(500, f"{type(e).__name__}: {e}")
        name = f"test-{role}-{int(time.time())}.wav"
        audio.write_wav(OUTPUT / "tests" / name, audio.stitch([seg], engine.sampling_rate, lead_ms=100, tail_ms=200), engine.sampling_rate)
        return {"url": f"/output/tests/{name}"}

    @app.post("/api/script/parse")
    def parse(body: ScriptText):
        try:
            return {"turns": script.parse_script(body.text, body.host_name, body.guest_name)}
        except script.ScriptError as e:
            raise HTTPException(400, str(e))

    @app.post("/api/script/simple")
    def simple(body: Interview):
        try:
            turns = script.simple_script(body.questions, body.answers, body.show_name, body.host_name, body.guest_name, body.topic)
        except script.ScriptError as e:
            raise HTTPException(400, str(e))
        return {"turns": turns, "text": script.turns_to_text(turns)}

    @app.post("/api/claude/questions")
    def claude_questions(body: Interview):
        try:
            qs = writer.write_questions(
                body.show_name, body.host_name, body.guest_name, body.guest_bio, body.topic, body.count, body.api_key or None
            )
        except writer.WriterError as e:
            raise HTTPException(400, str(e))
        return {"questions": qs}

    @app.post("/api/claude/script")
    def claude_script(body: Interview):
        if not body.questions or not any(a.strip() for a in body.answers):
            raise HTTPException(400, "Add the questions and the guest's answers first")
        try:
            result = writer.write_script(
                body.show_name, body.host_name, body.guest_name, body.topic, body.questions, body.answers, body.api_key or None
            )
        except writer.WriterError as e:
            raise HTTPException(400, str(e))
        return {**result, "text": script.turns_to_text(result["lines"])}

    @app.post("/api/render")
    def render(body: RenderRequest):
        try:
            turns = script.validate_turns([t.model_dump() for t in body.turns])
        except script.ScriptError as e:
            raise HTTPException(400, str(e))
        voices = {r: voice_meta(r) for r in script.SPEAKERS}
        missing = [r for r, v in voices.items() if v is None]
        if missing:
            raise HTTPException(400, f"Add a voice clip for: {', '.join(missing)}")
        if engine.state == "error":
            raise HTTPException(503, engine.error or "OmniVoice failed to load")
        job = renderer.start(turns, voices, body.model_dump(exclude={"turns"}))
        return job.public()

    @app.get("/api/jobs/{job_id}")
    def job_status(job_id: str):
        job = renderer.jobs.get(job_id)
        if job is None:
            raise HTTPException(404, "No such render")
        return job.public()

    @app.get("/api/episodes")
    def episodes():
        items = []
        for d in sorted(OUTPUT.glob("*/episode.wav"), reverse=True)[:20]:
            info = sf.info(str(d))
            items.append({"id": d.parent.name, "wav": f"/output/{d.parent.name}/episode.wav", "seconds": round(info.duration, 1)})
        return {"episodes": items}

    @app.exception_handler(HTTPException)
    def http_error(_, exc: HTTPException):
        return JSONResponse({"error": exc.detail}, status_code=exc.status_code)

    app.mount("/voices", StaticFiles(directory=VOICES), name="voices")
    app.mount("/output", StaticFiles(directory=OUTPUT), name="output")
    app.mount("/static", StaticFiles(directory=STATIC), name="static")
    return app


def main():
    p = argparse.ArgumentParser(description="Two-voice OmniVoice podcast maker")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--stub", action="store_true", help="Use tones instead of OmniVoice (for testing)")
    p.add_argument("--model", default="k2-fsa/OmniVoice", help="OmniVoice checkpoint or HF repo id")
    p.add_argument("--device", default=None, help="mps, cpu or cuda (auto-detected if unset)")
    p.add_argument("--dtype", default="float16", choices=["float16", "float32", "bfloat16"])
    args = p.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    engine = StubEngine() if args.stub else OmniVoiceEngine(args.model, args.device, args.dtype)
    engine.start_loading()
    app = create_app(engine)
    print(f"\n  OmniVoice Podcast ({engine.name}) is running at http://{args.host}:{args.port}\n", flush=True)
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
