"""Bucle principal del worker.

Consume la cola de PostgreSQL y ejecuta el pipeline de medios. Se lanzan tantas
copias como haga falta: `app.claim_jobs` usa SKIP LOCKED, asi que escalar es
arrancar mas procesos, sin coordinacion entre ellos.

    python workers/main.py                    # todos los tipos de trabajo
    python workers/main.py sanitize_exif      # solo sanitizacion

Se detiene de forma ordenada con Ctrl+C o SIGTERM: termina el trabajo que tiene
entre manos antes de salir, para no dejarlo a medias y con la cuota de intentos
gastada.
"""

from __future__ import annotations

import json
import logging
import signal
import sys
import tempfile
import time
from pathlib import Path

from config import Config, ConfigError
from db import Job, Queue
from sanitize import SanitizeError, strip_image_metadata, strip_video_metadata
from storage import build_client, download, upload
from transcode import extract_poster, to_web_mp4, to_webp
from watermark import watermark_image, watermark_video

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(message)s",
)
log = logging.getLogger("grindflow.worker")

_stop_requested = False


def _request_stop(signum: int, _frame: object) -> None:
    global _stop_requested
    _stop_requested = True
    log.info("senal %s recibida: se saldra al terminar el trabajo actual", signum)


def _derivative_key(original_key: str, suffix: str, extension: str) -> str:
    """Clave del derivado, fuera de `inbox/`.

    El prefijo `public/` marca lo que ya paso por sanitizacion y marca de agua,
    de modo que la separacion entre lo publicable y lo que no lo es se ve en la
    propia ruta del objeto.
    """
    stem = Path(original_key).stem
    parent = str(Path(original_key).parent).replace("/inbox", "/public")
    return f"{parent}/{stem}-{suffix}.{extension}"


def handle_sanitize(job: Job, config: Config, queue: Queue, client) -> None:
    """Limpia metadatos y genera los derivados web de un asset."""
    asset_key = job.payload.get("r2_key")
    asset_id = job.payload.get("asset_id")
    file_type = job.payload.get("file_type", "image")
    handle = job.payload.get("handle")

    if not asset_key or not asset_id:
        raise SanitizeError("payload incompleto: faltan r2_key o asset_id")

    with tempfile.TemporaryDirectory(prefix="grindflow-") as tmp:
        workdir = Path(tmp)
        original = download(client, config.r2_bucket, asset_key, workdir / "original")
        derivatives: dict[str, str] = {}

        if file_type == "image":
            clean = strip_image_metadata(original, workdir / "clean.jpg")
            webp = to_webp(clean, workdir / "web.webp")

            clean_key = _derivative_key(asset_key, "clean", "jpg")
            webp_key = _derivative_key(asset_key, "web", "webp")
            upload(client, config.r2_bucket, clean_key, clean, "image/jpeg")
            upload(client, config.r2_bucket, webp_key, webp, "image/webp")
            derivatives["clean"] = clean_key
            derivatives["webp"] = webp_key

            if handle:
                marked = watermark_image(clean, workdir / "teaser.jpg", handle)
                teaser_key = _derivative_key(asset_key, "teaser", "jpg")
                upload(client, config.r2_bucket, teaser_key, marked, "image/jpeg")
                derivatives["teaser"] = teaser_key
        else:
            clean = strip_video_metadata(original, workdir / "clean.mp4")
            web = to_web_mp4(clean, workdir / "web.mp4")
            poster = extract_poster(web, workdir / "poster.jpg")

            clean_key = _derivative_key(asset_key, "clean", "mp4")
            web_key = _derivative_key(asset_key, "web", "mp4")
            poster_key = _derivative_key(asset_key, "poster", "jpg")
            upload(client, config.r2_bucket, clean_key, clean, "video/mp4")
            upload(client, config.r2_bucket, web_key, web, "video/mp4")
            upload(client, config.r2_bucket, poster_key, poster, "image/jpeg")
            derivatives.update({"clean": clean_key, "web": web_key, "poster": poster_key})

            if handle:
                marked = watermark_video(web, workdir / "teaser.mp4", handle)
                teaser_key = _derivative_key(asset_key, "teaser", "mp4")
                upload(client, config.r2_bucket, teaser_key, marked, "video/mp4")
                derivatives["teaser"] = teaser_key

        # Solo ahora se levanta la bandera: hasta aqui el asset no era publicable
        # y la base rechazaba cualquier intento de programarlo.
        queue.mark_asset_sanitized(str(asset_id), json.dumps(derivatives))
        log.info("asset %s sanitizado, %d derivados", asset_id, len(derivatives))


HANDLERS = {
    "sanitize_exif": handle_sanitize,
    "watermark": handle_sanitize,
    "transcode": handle_sanitize,
    "generate_teaser": handle_sanitize,
}


def run() -> int:
    try:
        config = Config.from_env()
    except ConfigError as error:
        log.error("%s", error)
        return 1

    job_types = sys.argv[1:] or None
    queue = Queue(config.database_url, config.worker_name)
    client = build_client(config)

    signal.signal(signal.SIGINT, _request_stop)
    signal.signal(signal.SIGTERM, _request_stop)

    log.info(
        "worker %s en marcha (tipos: %s)",
        config.worker_name,
        ", ".join(job_types) if job_types else "todos",
    )

    while not _stop_requested:
        claimed = 0
        for job in queue.claim(config.batch_size, job_types):
            claimed += 1
            handler = HANDLERS.get(job.job_type)

            if handler is None:
                queue.complete(job.id, False, f"sin manejador para {job.job_type}")
                continue

            try:
                handler(job, config, queue, client)
                queue.complete(job.id, True)
            except Exception as error:  # noqa: BLE001
                # Se captura todo a proposito: un fallo en un archivo corrupto no
                # debe tumbar el worker y dejar la cola entera sin consumir.
                log.exception("trabajo %s fallo", job.id)
                queue.complete(job.id, False, str(error)[:1000])

        if claimed == 0:
            time.sleep(config.poll_seconds)

    log.info("worker %s detenido", config.worker_name)
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
