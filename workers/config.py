"""Configuracion de los workers, leida del entorno.

Falla al arrancar si falta algo, no a mitad de un trabajo: un worker que arranca
sin credenciales de R2 tomaria trabajos de la cola, los reventaria uno a uno y
los dejaria en 'dead' antes de que nadie note el problema.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


class ConfigError(RuntimeError):
    """Falta una variable de entorno obligatoria."""


def _required(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise ConfigError(
            f"Falta la variable de entorno {name}. Revisa .env.example."
        )
    return value


@dataclass(frozen=True)
class Config:
    database_url: str
    r2_endpoint: str
    r2_bucket: str
    r2_access_key_id: str
    r2_secret_access_key: str
    r2_region: str
    worker_name: str
    batch_size: int
    poll_seconds: float

    @classmethod
    def from_env(cls) -> "Config":
        return cls(
            database_url=_required("DATABASE_URL"),
            r2_endpoint=_required("R2_ENDPOINT"),
            r2_bucket=_required("R2_BUCKET"),
            r2_access_key_id=_required("R2_ACCESS_KEY_ID"),
            r2_secret_access_key=_required("R2_SECRET_ACCESS_KEY"),
            r2_region=os.environ.get("R2_REGION", "auto"),
            worker_name=os.environ.get("WORKER_NAME", f"worker-{os.getpid()}"),
            batch_size=int(os.environ.get("WORKER_BATCH_SIZE", "1")),
            poll_seconds=float(os.environ.get("WORKER_POLL_SECONDS", "5")),
        )
