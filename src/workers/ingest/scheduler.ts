import type { CloudConnectionRow } from '@/lib/database.types';
import { createServiceClient } from '@/lib/supabase/service';

/**
 * Programador de escaneos.
 *
 * El estudio no deberia pulsar un boton para que la plataforma mire si hay
 * material nuevo. Como el worker ya es un proceso persistente, el programador
 * vive dentro: no hace falta un cron del sistema, ni un contenedor aparte, ni
 * una dependencia mas.
 *
 * Con varias replicas del worker, todas despiertan y todas intentan encolar los
 * mismos escaneos. Eso no se resuelve aqui sino en la base: el indice
 * `jobs_one_live_scan_per_connection` deja pasar uno solo. Es la unica capa que
 * ven todas las replicas a la vez, y por eso la coordinacion vive ahi y no en
 * este codigo.
 */

/** Campos que necesita la decision. Recortado para que la funcion sea probable. */
export type SchedulableConnection = Pick<
  CloudConnectionRow,
  'id' | 'organization_id' | 'status' | 'last_scan_at' | 'scan_enabled' | 'scan_interval_minutes'
>;

/**
 * Decide si a una conexion le toca escaneo.
 *
 * Codigo puro y con el reloj por parametro: una funcion que llamara a
 * `Date.now()` por dentro no se podria probar sin esperar media hora.
 */
export function isDueForScan(connection: SchedulableConnection, now: Date): boolean {
  if (connection.status !== 'active') return false;
  if (!connection.scan_enabled) return false;

  // Nunca escaneada: le toca ya. Es el primer escaneo tras conectar, y hacerlo
  // esperar treinta minutos deja a quien acaba de conectar mirando una lista
  // vacia sin saber si funciono.
  if (connection.last_scan_at === null) return true;

  const elapsedMs = now.getTime() - new Date(connection.last_scan_at).getTime();
  return elapsedMs >= connection.scan_interval_minutes * 60_000;
}

export function connectionsDueForScan(
  connections: readonly SchedulableConnection[],
  now: Date,
): SchedulableConnection[] {
  return connections.filter((connection) => isDueForScan(connection, now));
}

export interface SchedulerOutcome {
  checked: number;
  due: number;
  enqueued: number;
  /** Ya habia un escaneo vivo para esa conexion: lo rechazo la base. */
  alreadyQueued: number;
}

/** Codigo de PostgreSQL para violacion de restriccion unica. */
const UNIQUE_VIOLATION = '23505';

export async function enqueueDueScans(now: Date = new Date()): Promise<SchedulerOutcome> {
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from('cloud_connections')
    .select('id, organization_id, status, last_scan_at, scan_enabled, scan_interval_minutes')
    .eq('status', 'active')
    .eq('scan_enabled', true);

  if (error !== null) {
    throw new Error(`No se pudieron leer las conexiones: ${error.message}`);
  }

  const connections: SchedulableConnection[] = data ?? [];
  const due = connectionsDueForScan(connections, now);

  const outcome: SchedulerOutcome = {
    checked: connections.length,
    due: due.length,
    enqueued: 0,
    alreadyQueued: 0,
  };

  for (const connection of due) {
    const { error: insertError } = await supabase.from('jobs').insert({
      organization_id: connection.organization_id,
      job_type: 'scan_cloud_folder',
      payload: { connection_id: connection.id },
    });

    if (insertError === null) {
      outcome.enqueued += 1;
      continue;
    }

    // El rechazo por duplicado es el caso normal con varias replicas, no un
    // error: significa que otra ya encolo ese escaneo.
    if (insertError.code === UNIQUE_VIOLATION) {
      outcome.alreadyQueued += 1;
      continue;
    }

    throw new Error(
      `No se pudo encolar el escaneo de ${connection.id}: ${insertError.message}`,
    );
  }

  return outcome;
}
