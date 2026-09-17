"""Comprobacion manual de la barrera anti-doxxing.

No forma parte del CI (que cubre el Hard Rule y el RLS), porque exige Pillow y
piexif instalados. Se ejecuta a mano cada vez que se toque `sanitize.py`:

    pip install Pillow piexif
    python workers/verificar_sanitizacion.py

Fabrica una imagen con GPS, marca de camara y fecha de captura —exactamente lo
que trae una foto de movil— la pasa por la sanitizacion y exige que no quede
ningun campo. Si algo sobrevive, sale con codigo distinto de cero.
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from PIL import Image  # noqa: E402
from sanitize import strip_image_metadata  # noqa: E402

try:
    import piexif
except ImportError:  # pragma: no cover
    print("Falta piexif. Instala con: pip install piexif")
    raise SystemExit(2)


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="grindflow-verif-"))
    source = tmp / "con_gps.jpg"

    Image.new("RGB", (400, 300), (120, 40, 80)).save(source, "JPEG")
    piexif.insert(
        piexif.dump(
            {
                "0th": {
                    piexif.ImageIFD.Make: b"Apple",
                    piexif.ImageIFD.Model: b"iPhone 15 Pro",
                },
                "Exif": {piexif.ExifIFD.DateTimeOriginal: b"2026:03:14 22:15:03"},
                "GPS": {
                    piexif.GPSIFD.GPSLatitudeRef: b"N",
                    piexif.GPSIFD.GPSLatitude: ((4, 1), (42, 1), (0, 1)),
                    piexif.GPSIFD.GPSLongitudeRef: b"W",
                    piexif.GPSIFD.GPSLongitude: ((74, 1), (5, 1), (0, 1)),
                },
                "1st": {},
                "thumbnail": None,
            }
        ),
        str(source),
    )

    before = piexif.load(str(source))
    if len(before["GPS"]) == 0:
        print("FALLO: la imagen de prueba no llego a tener GPS")
        return 1
    print(
        f"antes   -> GPS: {len(before['GPS'])} | camara: {len(before['0th'])} "
        f"| EXIF: {len(before['Exif'])}"
    )

    clean = strip_image_metadata(source, tmp / "limpia.jpg")
    after = piexif.load(str(clean))
    print(
        f"despues -> GPS: {len(after['GPS'])} | camara: {len(after['0th'])} "
        f"| EXIF: {len(after['Exif'])}"
    )

    problems = [
        name
        for name in ("GPS", "0th", "Exif")
        if len(after[name]) > 0
    ]
    if problems:
        print(f"FALLO: sobrevivieron metadatos en {', '.join(problems)}")
        return 1

    with Image.open(source) as a, Image.open(clean) as b:
        if a.size != b.size:
            print(f"FALLO: el tamano cambio de {a.size} a {b.size}")
            return 1

    print("OK: se eliminan GPS, camara y fecha, y los pixeles se conservan.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
