"""Transcodificacion a formatos web.

R2 no cobra egreso, pero el ancho de banda del visitante si cuesta: un teaser de
Telegram que tarda en cargar se pierde. De ahi el perfil H.264 baseline-ish con
faststart, que empieza a reproducirse antes de descargarse entero.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

from PIL import Image

from sanitize import SanitizeError


def to_web_mp4(source: Path, destination: Path, max_height: int = 1080) -> Path:
    """Convierte a MP4 H.264 optimizado para reproduccion progresiva."""
    destination.parent.mkdir(parents=True, exist_ok=True)

    result = subprocess.run(
        [
            "ffmpeg", "-y",
            "-i", str(source),
            # Solo reduce; nunca amplia un video que ya es mas pequeno. El -2
            # mantiene la proporcion con un alto par, que exige H.264.
            "-vf", f"scale=-2:'min({max_height},ih)'",
            "-c:v", "libx264",
            "-preset", "medium",
            "-crf", "23",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac",
            "-b:a", "128k",
            "-movflags", "+faststart",
            "-map_metadata", "-1",
            str(destination),
        ],
        capture_output=True,
        text=True,
        check=False,
    )

    if result.returncode != 0:
        raise SanitizeError(f"ffmpeg fallo transcodificando {source.name}: {result.stderr[-500:]}")

    return destination


def to_webp(source: Path, destination: Path, max_width: int = 1600) -> Path:
    """Genera la version WEBP para la web."""
    destination.parent.mkdir(parents=True, exist_ok=True)

    with Image.open(source) as image:
        if image.width > max_width:
            ratio = max_width / image.width
            image = image.resize((max_width, int(image.height * ratio)), Image.LANCZOS)
        image.convert("RGB").save(destination, format="WEBP", quality=82, method=4)

    return destination


def extract_poster(source: Path, destination: Path, at_second: float = 1.0) -> Path:
    """Saca un fotograma para usarlo como portada del video."""
    destination.parent.mkdir(parents=True, exist_ok=True)

    result = subprocess.run(
        [
            "ffmpeg", "-y",
            "-ss", str(at_second),
            "-i", str(source),
            "-frames:v", "1",
            "-q:v", "3",
            str(destination),
        ],
        capture_output=True,
        text=True,
        check=False,
    )

    if result.returncode != 0:
        raise SanitizeError(f"ffmpeg fallo extrayendo portada de {source.name}")

    return destination
