"""Runs without OmniVoice: the stub engine stands in for the voice model."""

import io
import sys
import time
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import server  # noqa: E402
from podcast import audio, script  # noqa: E402
from podcast.tts import StubEngine  # noqa: E402


def wav_bytes(seconds=6.0, sr=24000, f=180.0):
    t = np.arange(int(sr * seconds)) / sr
    buf = io.BytesIO()
    sf.write(buf, (0.3 * np.sin(2 * np.pi * f * t)).astype(np.float32), sr, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def test_parse_labels_names_and_continuations():
    text = """# comment
HOST: Welcome to the show.
Maria: Thanks for having me.
  And it's great to be here.
**Jacob:** First question?
guest: Sure."""
    turns = script.parse_script(text, host_name="Jacob", guest_name="Maria Lopez")
    assert [t["speaker"] for t in turns] == ["host", "guest", "host", "guest"]
    assert turns[1]["text"] == "Thanks for having me. And it's great to be here."


def test_parse_rejects_unlabelled_start():
    with pytest.raises(script.ScriptError):
        script.parse_script("Hello there")


def test_simple_script_keeps_answers_verbatim():
    turns = script.simple_script(["Q one?", "Q two?"], ["Answer one.", "Answer two."], "Show", "Jacob", "Maria")
    guest = [t["text"] for t in turns if t["speaker"] == "guest"]
    assert "Answer one." in guest and "Answer two." in guest
    assert turns[0]["speaker"] == "host" and turns[-1]["speaker"] == "host"


def test_stitch_length_and_level():
    sr = 24000
    segs = [np.ones(sr, dtype=np.float32) * 0.01, np.ones(sr // 2, dtype=np.float32) * 0.5]
    out = audio.stitch(segs, sr, gap_ms=500, lead_ms=300, tail_ms=600)
    assert len(out) == sr + sr // 2 + int(sr * 0.5) + int(sr * 0.3) + int(sr * 0.6)
    assert np.max(np.abs(out)) <= 0.9


@pytest.fixture
def client(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    monkeypatch.setattr(server, "VOICES", tmp_path / "voices")
    monkeypatch.setattr(server, "OUTPUT", tmp_path / "output")
    return TestClient(server.create_app(StubEngine()))


def test_full_flow_with_stub(client, monkeypatch):
    assert client.get("/").status_code == 200
    assert client.get("/api/status").json()["engine"] == "stub"

    r = client.post("/api/render", json={"turns": [{"speaker": "host", "text": "Hi"}]})
    assert r.status_code == 400 and "voice clip" in r.json()["error"]

    for role, f in (("host", 150.0), ("guest", 230.0)):
        r = client.post(
            f"/api/voices/{role}",
            files={"file": (f"{role}.wav", wav_bytes(f=f), "audio/wav")},
            data={"name": "Jacob" if role == "host" else "Maria", "transcript": "Hello there."},
        )
        assert r.status_code == 200, r.text
        assert r.json()["seconds"] == 6.0

    assert client.post("/api/voices/guest/test", json={}).status_code == 200

    turns = client.post(
        "/api/script/parse", json={"text": "HOST: Welcome, Maria.\nGUEST: Thanks, Jacob, glad to be here.\nHOST: Bye."}
    ).json()["turns"]
    job = client.post("/api/render", json={"turns": turns, "gap_ms": 400}).json()
    for _ in range(600):
        j = client.get(f"/api/jobs/{job['id']}").json()
        if j["status"] in ("done", "error"):
            break
        time.sleep(0.05)
    assert j["status"] == "done", j
    wav = client.get(j["files"]["wav"])
    assert wav.status_code == 200
    data, sr = sf.read(io.BytesIO(wav.content))
    assert sr == 24000 and 3.0 < len(data) / sr < 10.0
    assert len(list((server.OUTPUT / job["id"] / "lines").glob("*.wav"))) == 3
    assert client.get("/api/episodes").json()["episodes"][0]["id"] == job["id"]


def test_claude_without_key_gives_a_clear_error(client, monkeypatch):
    for var in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_PROFILE"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("HOME", "/nonexistent")
    r = client.post("/api/claude/questions", json={"topic": "local SEO"})
    assert r.status_code == 400
    assert "key" in r.json()["error"].lower()


def test_omnivoice_engine_calls_the_real_api_shape(tmp_path, monkeypatch):
    """Fake omnivoice/torch modules with the signatures from omnivoice 0.2.1, to check the glue."""
    import types

    calls = {}

    class FakeModel:
        sampling_rate = 24000

        def create_voice_clone_prompt(self, ref_audio, ref_text=None, preprocess_prompt=True):
            calls.setdefault("prompts", []).append((Path(ref_audio).name, ref_text))
            return ("prompt", ref_audio)

        def generate(self, text, language=None, voice_clone_prompt=None, num_step=32, speed=None, **kw):
            calls.setdefault("gen", []).append((text, language, voice_clone_prompt, num_step, speed))
            return [np.zeros(2400, dtype=np.float32)]

    class FakeOmniVoice:
        @classmethod
        def from_pretrained(cls, name, device_map=None, dtype=None):
            calls["load"] = (name, device_map, dtype)
            return FakeModel()

    torch = types.ModuleType("torch")
    torch.float16, torch.float32, torch.bfloat16 = "f16", "f32", "bf16"
    ov = types.ModuleType("omnivoice")
    ov.OmniVoice, ov.__version__ = FakeOmniVoice, "0.2.1"
    utils = types.ModuleType("omnivoice.utils")
    common = types.ModuleType("omnivoice.utils.common")
    common.get_best_device = lambda: "mps"
    for name, mod in {"torch": torch, "omnivoice": ov, "omnivoice.utils": utils, "omnivoice.utils.common": common}.items():
        monkeypatch.setitem(sys.modules, name, mod)

    from podcast.tts import OmniVoiceEngine

    eng = OmniVoiceEngine()
    eng.start_loading()
    eng.wait_until_ready(5)
    assert eng.status()["state"] == "ready" and eng.device == "mps"
    assert calls["load"] == ("k2-fsa/OmniVoice", "mps", "f16")

    ref = tmp_path / "host.wav"
    ref.write_bytes(wav_bytes())
    eng.generate("One.", ref, "Hello there.", num_step=16)
    eng.generate("Two.", ref, "Hello there.", speed=1.1)
    assert len(calls["prompts"]) == 1  # the voice is cloned once and reused
    assert calls["gen"][0][1:] == ("en", ("prompt", str(ref)), 16, None)
    assert calls["gen"][1][4] == 1.1
