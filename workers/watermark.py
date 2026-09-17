"""Marca de agua dinamica sobre los archivos de teaser.

Solo se aplica al material publico. El original limpio se conserva intacto en el
vault: la marca es para la copia que sale a la calle, no para el archivo maestro.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from sanitize import SanitizeError


def watermark_image(
    source: Path,
    destination: Path,
    handle: str,
    opacity: int = 140,
) -> Path:
    """Estampa el @handle en la esquina inferior derecha.

    El tamano del texto se calcula como fraccion del ancho, no en pixeles fijos:
    una marca de 24 px es enorme en una miniatura e invisible en un archivo de
    4000 px de ancho.
    """
    destination.parent.mkdir(parents=True, exist_ok=True)

    with Image.open(source).convert("RGBA") as base:
        overlay = Image.new("RGBA", base.size, (255, 255, 255, 0))
        draw = ImageDraw.Draw(overlay)

        font_size = max(14, base.width // 28)
        font = _load_font(font_size)

        text = handle if handle.startswith("@") else f"@{handle}"
        box = draw.textbbox((0, 0), text, font=font)
        margin = max(10, base.width // 60)
        position = (
            base.width - (box[2] - box[0]) - margin,
            base.height - (box[3] - box[1]) - margin,
        )

        # Sombra un pixel por debajo: mantiene el texto legible tanto sobre
        # zonas claras como oscuras sin recurrir a un recuadro opaco.
        draw.text((position[0] + 1, position[1] + 1), text, font=font, fill=(0, 0, 0, opacity))
        draw.text(position, text, font=font, fill=(255, 255, 255, opacity))

        Image.alpha_composite(base, overlay).convert("RGB").save(
            destination, format="JPEG", quality=90
        )

    return destination


def _load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for candidate in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    ):
        if Path(candidate).exists():
            return ImageFont.truetype(candidate, size)
    # Sin fuentes del sistema la marca sale pequena, pero sale: preferible a
    # abortar el trabajo entero.
    return ImageFont.load_default()


def watermark_video(source: Path, destination: Path, handle: str) -> Path:
    """Superpone el @handle en el video con el filtro drawtext de FFmpeg."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    text = handle if handle.startswith("@") else f"@{handle}"
    # Escapado para el filtro: una comilla o dos puntos sin escapar rompen la
    # cadena de filtros de FFmpeg.
    safe_text = text.replace("\\", "\\\\").replace(":", "\\:").replace("'", "")

    result = subprocess.run(
        [
            "ffmpeg", "-y",
            "-i", str(source),
            "-vf",
            (
                f"drawtext=text='{safe_text}':fontcolor=white@0.55:"
                "fontsize=h/22:x=w-tw-20:y=h-th-20:shadowcolor=black@0.5:"
                "shadowx=1:shadowy=1"
            ),
            "-c:a", "copy",
            "-movflags", "+faststart",
            str(destination),
        ],
        capture_output=True,
        text=True,
        check=False,
    )

    if result.returncode != 0:
        raise SanitizeError(
            f"ffmpeg fallo aplicando marca de agua a {source.name}: {result.stderr[-500:]}"
        )

    return destination
