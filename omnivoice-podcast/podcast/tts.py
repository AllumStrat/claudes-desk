"""Text-to-speech engines.

OmniVoiceEngine runs k2-fsa OmniVoice in this process (zero-shot cloning from a short clip).
StubEngine makes tones instead of speech, so the app can be tested without OmniVoice.
"""

from __future__ import annotations

import hashlib
import logging
import threading
import traceback
from pathlib import Path

import numpy as np

log = logging.getLogger("podcast.tts")


def _file_key(path: Path, ref_text: str | None) -> str:
    h = hashlib.sha1(Path(path).read_bytes())
    h.update((ref_text or "").encode())
    return h.hexdigest()


class StubEngine:
    """Fake voices: a hum whose pitch depends on the reference clip, timed to the text."""

    name = "stub"
    sampling_rate = 24000

    def __init__(self):
        self.state = "ready"
        self.error = None
        self.device = "none"

    def status(self) -> dict:
        return {"engine": self.name, "state": self.state, "device": self.device, "error": None}

    def start_loading(self):
        pass

    def generate(self, text: str, ref_audio: Path, ref_text: str | None, **_) -> np.ndarray:
        seed = int(_file_key(ref_audio, ref_text)[:6], 16)
        f0 = 110 + seed % 140  # different voices get different pitches
        words = max(1, len(text.split()))
        dur = 0.3 * words + 0.2
        t = np.arange(int(self.sampling_rate * dur)) / self.sampling_rate
        syll = 0.5 + 0.5 * np.sin(2 * np.pi * 3.2 * t) ** 2
        wave = (np.sin(2 * np.pi * f0 * t) + 0.4 * np.sin(2 * np.pi * 2 * f0 * t)) * syll
        return (0.2 * wave).astype(np.float32)


class OmniVoiceEngine:
    name = "omnivoice"

    def __init__(self, model_id: str = "k2-fsa/OmniVoice", device: str | None = None, dtype: str = "float16"):
        self.model_id = model_id
        self.requested_device = device
        self.dtype_name = dtype
        self.device = device or "auto"
        self.model = None
        self.state = "not_loaded"  # not_loaded | loading | ready | error
        self.error: str | None = None
        self.version: str | None = None
        self._prompts: dict[str, object] = {}
        self._lock = threading.Lock()  # one generation at a time
        self._load_thread: threading.Thread | None = None

    @property
    def sampling_rate(self) -> int:
        return int(getattr(self.model, "sampling_rate", None) or 24000)

    def status(self) -> dict:
        return {
            "engine": self.name,
            "state": self.state,
            "device": self.device,
            "dtype": self.dtype_name,
            "model": self.model_id,
            "omnivoice_version": self.version,
            "error": self.error,
        }

    def start_loading(self):
        if self.state in ("loading", "ready"):
            return
        self.state = "loading"
        self.error = None
        self._load_thread = threading.Thread(target=self._load, daemon=True)
        self._load_thread.start()

    def _load(self):
        try:
            import torch
            import omnivoice
            from omnivoice import OmniVoice
            from omnivoice.utils.common import get_best_device

            self.version = getattr(omnivoice, "__version__", None)
            device = self.requested_device or get_best_device()
            self.device = device
            dtype = {"float16": torch.float16, "float32": torch.float32, "bfloat16": torch.bfloat16}[self.dtype_name]
            log.info("Loading %s on %s (%s). The first run downloads the model.", self.model_id, device, self.dtype_name)
            self.model = OmniVoice.from_pretrained(self.model_id, device_map=device, dtype=dtype)
            self.state = "ready"
            log.info("OmniVoice is ready on %s.", device)
        except ImportError as e:
            self.state = "error"
            self.error = f"OmniVoice isn't installed in this Python ({e}). Run ./run.sh --setup or point PYTHON at the env that has it."
            log.error(self.error)
        except Exception as e:  # noqa: BLE001
            self.state = "error"
            self.error = f"{type(e).__name__}: {e}"
            log.error("OmniVoice failed to load:\n%s", traceback.format_exc())

    def wait_until_ready(self, timeout: float | None = None):
        if self._load_thread is not None:
            self._load_thread.join(timeout)
        if self.state != "ready":
            raise RuntimeError(self.error or f"OmniVoice is {self.state}")

    def _prompt(self, ref_audio: Path, ref_text: str | None):
        key = _file_key(ref_audio, ref_text)
        if key not in self._prompts:
            log.info("Cloning voice from %s", Path(ref_audio).name)
            self._prompts[key] = self.model.create_voice_clone_prompt(
                ref_audio=str(ref_audio), ref_text=ref_text or None
            )
        return self._prompts[key]

    def generate(
        self,
        text: str,
        ref_audio: Path,
        ref_text: str | None,
        language: str = "en",
        num_step: int = 32,
        speed: float | None = None,
    ) -> np.ndarray:
        self.wait_until_ready()
        with self._lock:
            prompt = self._prompt(ref_audio, ref_text)
            kwargs = {"text": text, "language": language, "voice_clone_prompt": prompt, "num_step": int(num_step)}
            if speed and abs(float(speed) - 1.0) > 1e-3:
                kwargs["speed"] = float(speed)
            audios = self.model.generate(**kwargs)
        return np.asarray(audios[0], dtype=np.float32)
