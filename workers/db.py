"""Acceso a la cola de trabajos.

Los workers no hablan con PostgREST ni con la API de Supabase: van directos a
PostgreSQL con la cadena de conexion de servicio. Las dos funciones de la cola
—`app.claim_jobs` y `app.complete_job`— viven en la base (migracion 000500), de
modo que la exclusion entre workers y el reintento con espera exponencial son
responsabilidad del motor y no de este codigo.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterator

import psycopg
from psycopg.rows import dict_row


@dataclass(frozen=True)
class Job:
    id: str
    organization_id: str
    job_type: str
    payload: dict[str, Any]
    attempts: int


class Queue:
    def __init__(self, database_url: str, worker_name: str) -> None:
        self._database_url = database_url
        self._worker_name = worker_name

    def _connect(self) -> psycopg.Connection:
        return psycopg.connect(self._database_url, row_factory=dict_row)

    def claim(self, batch_size: int, job_types: list[str] | None = None) -> Iterator[Job]:
        """Toma hasta `batch_size` trabajos pendientes.

        `app.claim_jobs` usa FOR UPDATE SKIP LOCKED: varios workers pueden
        consumir a la vez sin bloquearse ni recibir el mismo trabajo.
        """
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(
                "select * from app.claim_jobs(%s, %s, %s)",
                (self._worker_name, batch_size, job_types),
            )
            for row in cur.fetchall():
                yield Job(
                    id=str(row["id"]),
                    organization_id=str(row["organization_id"]),
                    job_type=row["job_type"],
                    payload=row["payload"] or {},
                    attempts=row["attempts"],
                )

    def complete(self, job_id: str, success: bool, error: str | None = None) -> None:
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(
                "select app.complete_job(%s, %s, %s)", (job_id, success, error)
            )

    def mark_asset_sanitized(self, asset_id: str, derivatives: str) -> None:
        """Levanta la bandera que desbloquea la programacion de ese asset.

        Hasta que esto ocurre, el trigger `schedules_enforce_gates` rechaza
        cualquier intento de programarlo: un archivo con EXIF puede llevar las
        coordenadas GPS del domicilio de la modelo.
        """
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(
                """
                update public.media_assets
                   set sanitized = true,
                       status = case when status = 'raw' then 'edited' else status end,
                       derivatives = %s::jsonb
                 where id = %s
                """,
                (derivatives, asset_id),
            )
