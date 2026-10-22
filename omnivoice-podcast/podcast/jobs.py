"""Render a script into one episode in the background, line by line."""

from __future__ import annotations

import logging
import threading
import time
import traceback
import uuid
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from . import audio

log = logging.getLogger("podcast.jobs")


@dataclass
class Job:
    id: str
    total: int
    status: str = "queued"  # queued | running | done | error
    done: int = 0
    current: str = ""
    error: str | None = None
    started: float = field(default_factory=time.time)
    finished: float | None = None
    files: dict = field(default_factory=dict)
    duration: float | None = None
    line_seconds: list = field(default_factory=list)

    def public(self) -> dict:
        return {
            "id": self.id,
            "status": self.status,
            "done": self.done,
            "total": self.total,
            "current": self.current,
            "error": self.error,
            "elapsed": round((self.finished or time.time()) - self.started, 1),
            "files": self.files,
            "duration": self.duration,
        }


class Renderer:
    def __init__(self, engine, out_dir: Path):
        self.engine = engine
        self.out_dir = Path(out_dir)
        self.jobs: dict[str, Job] = {}
        self._queue_lock = threading.Lock()  # one episode at a time

    def start(self, turns: list[dict], voices: dict, options: dict) -> Job:
        job = Job(id=time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:4], total=len(turns))
        self.jobs[job.id] = job
        threading.Thread(target=self._run, args=(job, turns, voices, options), daemon=True).start()
        return job

    def _run(self, job: Job, turns: list[dict], voices: dict, options: dict):
        with self._queue_lock:
            job.status = "running"
            job_dir = self.out_dir / job.id
            try:
                sr = None
                segments: list[np.ndarray] = []
                for i, turn in enumerate(turns):
                    voice = voices[turn["speaker"]]
                    job.current = f'{voice["name"]}: {turn["text"][:80]}'
                    t0 = time.time()
                    seg = self.engine.generate(
                        text=turn["text"],
                        ref_audio=voice["path"],
                        ref_text=voice.get("transcript") or None,
                        language=options.get("language", "en"),
                        num_step=options.get("num_step", 32),
                        speed=options.get("speed"),
                    )
                    sr = self.engine.sampling_rate
                    audio.write_wav(job_dir / "lines" / f"{i + 1:03d}-{turn['speaker']}.wav", seg, sr)
                    segments.append(seg)
                    job.line_seconds.append(round(time.time() - t0, 1))
                    job.done = i + 1
                    log.info("Line %d/%d done in %.1fs", i + 1, len(turns), time.time() - t0)
                job.current = "Stitching the episode"
                episode = audio.stitch(segments, sr, gap_ms=int(options.get("gap_ms", 350)))
                wav = audio.write_wav(job_dir / "episode.wav", episode, sr)
                job.files["wav"] = f"/output/{job.id}/episode.wav"
                mp3 = audio.to_mp3(wav)
                if mp3:
                    job.files["mp3"] = f"/output/{job.id}/episode.mp3"
                (job_dir / "script.txt").write_text(
                    "\n".join(f"{voices[t['speaker']]['name']}: {t['text']}" for t in turns) + "\n"
                )
                job.duration = round(len(episode) / sr, 1)
                job.status = "done"
                job.current = ""
            except Exception as e:  # noqa: BLE001
                job.status = "error"
                job.error = f"{type(e).__name__}: {e}"
                log.error("Render failed:\n%s", traceback.format_exc())
            finally:
                job.finished = time.time()
