"""Stitch generated lines into one episode."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import numpy as np
import soundfile as sf


def _mono(x: np.ndarray) -> np.ndarray:
    x = np.asarray(x, dtype=np.float32)
    if x.ndim == 2:
        # (C, T) or (T, C) -> mono
        x = x.mean(axis=0) if x.shape[0] < x.shape[1] else x.mean(axis=1)
    return x.reshape(-1)


def _level(x: np.ndarray, target_rms: float = 0.08) -> np.ndarray:
    """Bring each line to a similar loudness so the two voices match."""
    rms = float(np.sqrt(np.mean(x**2))) if x.size else 0.0
    if rms > 1e-5:
        x = x * min(target_rms / rms, 4.0)
    return x


def _fade(x: np.ndarray, sr: int, ms: int = 8) -> np.ndarray:
    n = min(int(sr * ms / 1000), x.size // 2)
    if n > 0:
        ramp = np.linspace(0.0, 1.0, n, dtype=np.float32)
        x = x.copy()
        x[:n] *= ramp
        x[-n:] *= ramp[::-1]
    return x


def stitch(
    segments: list[np.ndarray],
    sr: int,
    gap_ms: int = 350,
    lead_ms: int = 300,
    tail_ms: int = 600,
) -> np.ndarray:
    """Join lines with a short silence between turns and normalise the result."""
    gap = np.zeros(int(sr * gap_ms / 1000), dtype=np.float32)
    parts = [np.zeros(int(sr * lead_ms / 1000), dtype=np.float32)]
    for i, seg in enumerate(segments):
        seg = _fade(_level(_mono(seg)), sr)
        if i:
            parts.append(gap)
        parts.append(seg)
    parts.append(np.zeros(int(sr * tail_ms / 1000), dtype=np.float32))
    out = np.concatenate(parts)
    peak = float(np.max(np.abs(out))) if out.size else 0.0
    if peak > 0:
        out = out * (0.89 / peak)  # about -1 dBFS
    return out.astype(np.float32)


def write_wav(path: Path, audio: np.ndarray, sr: int) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), audio, sr, subtype="PCM_16")
    return path


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None


def to_mp3(wav_path: Path, bitrate: str = "160k") -> Path | None:
    """Make an MP3 next to the WAV when ffmpeg is installed. Returns None otherwise."""
    if not ffmpeg_available():
        return None
    mp3 = wav_path.with_suffix(".mp3")
    result = subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav_path), "-codec:a", "libmp3lame", "-b:a", bitrate, str(mp3)],
        capture_output=True,
        text=True,
    )
    return mp3 if result.returncode == 0 and mp3.exists() else None
