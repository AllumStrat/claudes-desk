"""Check that OmniVoice works in this Python, without the web app.

    python check_omnivoice.py               # is it installed, which device will it use
    python check_omnivoice.py --generate    # load the model and make a two-voice test clip

The --generate test uses OmniVoice's built-in voice design (no clips needed), so it proves
the model runs and can speak in two different voices. It writes two-voice-check.wav here.
"""

import argparse
import sys
import time
from pathlib import Path


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--generate", action="store_true")
    p.add_argument("--device", default=None)
    args = p.parse_args()

    print(f"Python {sys.version.split()[0]} at {sys.executable}")
    try:
        import torch
    except ImportError:
        sys.exit("torch is not installed here. Run ./run.sh --setup, or activate the env where OmniVoice lives.")
    print(f"torch {torch.__version__}, Apple GPU (MPS) available: {torch.backends.mps.is_available()}")
    try:
        import omnivoice
        from omnivoice import OmniVoice
        from omnivoice.utils.common import get_best_device
    except ImportError as e:
        sys.exit(f"OmniVoice is not installed in this Python ({e}).")
    device = args.device or get_best_device()
    print(f"omnivoice {omnivoice.__version__}, will run on: {device}")
    if not args.generate:
        print("OK. Add --generate to load the model and make a test clip.")
        return

    import numpy as np
    import soundfile as sf

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from podcast.audio import stitch

    t0 = time.time()
    model = OmniVoice.from_pretrained("k2-fsa/OmniVoice", device_map=device, dtype=torch.float16)
    print(f"Model loaded in {time.time() - t0:.0f}s")
    lines = [
        ("male, low pitch, american accent", "Welcome to the show. This is the host speaking."),
        ("female, moderate pitch, american accent", "Thanks for having me. And this is the guest, in a different voice."),
    ]
    segs = []
    for instruct, text in lines:
        t0 = time.time()
        segs.append(np.asarray(model.generate(text=text, language="en", instruct=instruct, num_step=16)[0]))
        print(f"  {instruct}: {time.time() - t0:.1f}s")
    out = Path("two-voice-check.wav")
    sf.write(out, stitch(segs, model.sampling_rate), model.sampling_rate)
    print(f"Wrote {out.resolve()}. Play it: afplay {out}")


if __name__ == "__main__":
    main()
