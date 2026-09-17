"""Anti-doxxing: retirada de metadatos EXIF y GPS.

Es la pieza mas importante del pipeline. Una foto sacada con un movil lleva por
defecto las coordenadas exactas de donde se tomo, el modelo del aparato y su
numero de serie. Publicar eso puede revelar el domicilio de la modelo, y a
diferencia de una mala programacion, ese dano no se deshace borrando el post.

El criterio es reconstruir, no editar: se crea una imagen nueva con solo los
pixeles, en vez de intentar borrar campos de la original. Editar deja restos
—perfiles ICC, segmentos XMP, miniaturas incrustadas que conservan su propio
EXIF— y basta que quede uno para que la ubicacion siga ahi.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

from PIL import Image


class SanitizeError(RuntimeError):
    """El archivo no se pudo limpiar y no debe considerarse publicable."""


def strip_image_metadata(source: Path, destination: Path) -> Path:
    """Reescribe la imagen sin ningun metadato."""
    destination.parent.mkdir(parents=True, exist_ok=True)

    with Image.open(source) as image:
        # La rotacion vive en EXIF: hay que aplicarla ANTES de descartarlo, o la
        # foto sale girada.
        image = _apply_exif_orientation(image)

        clean = Image.new(image.mode, image.size)
        clean.putdata(list(image.getdata()))
        clean.save(destination, format=image.format or "JPEG", quality=92)

    _assert_no_exif(destination)
    return destination


def _apply_exif_orientation(image: Image.Image) -> Image.Image:
    try:
        exif = image.getexif()
    except Exception:  # noqa: BLE001 - una imagen sin EXIF legible no es un error
        return image

    orientation = exif.get(0x0112)
    rotations = {3: 180, 6: 270, 8: 90}
    if orientation in rotations:
        return image.rotate(rotations[orientation], expand=True)
    return image


def _assert_no_exif(path: Path) -> None:
    """Comprueba el resultado en vez de confiar en el.

    Si quedara EXIF, el archivo se marcaria como sanitizado y entraria en la cola
    de publicacion con las coordenadas intactas. Vale mucho mas fallar aqui.
    """
    with Image.open(path) as image:
        exif = image.getexif()
        if exif is not None and len(exif) > 0:
            raise SanitizeError(
                f"{path.name}: quedaron {len(exif)} campos EXIF tras la limpieza"
            )


def strip_video_metadata(source: Path, destination: Path) -> Path:
    """Copia el video sin contenedor de metadatos y sin recodificar.

    `-c copy` no vuelve a comprimir: la limpieza es casi instantanea y no pierde
    calidad. `-map_metadata -1` descarta las etiquetas globales y
    `-map_chapters -1` los capitulos, que tambien pueden llevar datos del autor.
    """
    destination.parent.mkdir(parents=True, exist_ok=True)

    result = subprocess.run(
        [
            "ffmpeg", "-y",
            "-i", str(source),
            "-map_metadata", "-1",
            "-map_chapters", "-1",
            "-c", "copy",
            "-movflags", "+faststart",
            str(destination),
        ],
        capture_output=True,
        text=True,
        check=False,
    )

    if result.returncode != 0:
        raise SanitizeError(f"ffmpeg fallo limpiando {source.name}: {result.stderr[-500:]}")

    return destination
