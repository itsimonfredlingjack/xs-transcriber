#!/usr/bin/env python3
from __future__ import annotations

import os
import sys
from pathlib import Path

import ctranslate2
from faster_whisper import __version__ as faster_whisper_version


def main() -> int:
    cache = Path(os.getenv("WHISPER_CACHE_DIR", "/home/simon/whisper/models"))
    devices = ctranslate2.get_cuda_device_count()
    print(f"Python: {sys.version.split()[0]}")
    print(f"faster-whisper: {faster_whisper_version}")
    print(f"CTranslate2: {ctranslate2.__version__}")
    print(f"CUDA devices: {devices}")
    if devices:
        print(f"CUDA compute types: {sorted(ctranslate2.get_supported_compute_types('cuda'))}")
    print(f"Model cache: {cache} ({'exists' if cache.is_dir() else 'missing'})")
    return 0 if devices and "float16" in ctranslate2.get_supported_compute_types("cuda") else 1


if __name__ == "__main__":
    raise SystemExit(main())
