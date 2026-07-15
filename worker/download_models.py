#!/usr/bin/env python3
"""Download only the CTranslate2 files used by faster-whisper."""

from __future__ import annotations

import os
from pathlib import Path

from faster_whisper.utils import download_model


def main() -> None:
    cache = Path(os.getenv("WHISPER_CACHE_DIR", "/home/simon/whisper/models"))
    cache.mkdir(parents=True, exist_ok=True)
    live = os.getenv("WHISPER_LIVE_MODEL", "KBLab/kb-whisper-small")
    final = os.getenv("WHISPER_FINAL_MODEL", "KBLab/kb-whisper-large")
    revision = os.getenv("WHISPER_FINAL_REVISION", "strict")

    print(f"Downloading live model {live} to {cache}")
    live_path = download_model(live, cache_dir=str(cache))
    print(f"Live model ready: {live_path}")
    print(f"Downloading final model {final}@{revision} to {cache}")
    final_path = download_model(final, cache_dir=str(cache), revision=revision)
    print(f"Final model ready: {final_path}")


if __name__ == "__main__":
    main()
