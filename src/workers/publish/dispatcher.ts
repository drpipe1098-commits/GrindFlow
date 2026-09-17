import type { ScheduleRow } from '@/lib/database.types';
import { createServiceClient } from '@/lib/supabase/service';

/**
 * Despachador: convierte programaciones vencidas en trabajos de publicacion.
 *
 * Vive dentro del worker, como el programador de escaneos y por la misma razon:
 * el proceso ya es persistente y no hace falta un cron aparte.
 *
 * La proteccion contra replicas tambien es la misma y esta en la base:
 * `jobs_one_live_publish_per_schedule`. Aqui tiene una consecuencia peor que en
 * el escaneo — dos trabajos vivos para la misma fila publican el mismo contenido
 * dos veces en la cuenta de la modelo, y eso el publico si lo ve.
 */

export type DispatchableSchedule = Pick<ScheduleRow, 'id' | 'organization_id' | 'scheduled_at' | 'status'>;

/**
 * Programaciones que ya toca publicar.
 *
 * Codigo puro con el reloj por parametro. Incluye las atrasadas: si el worker
 * estuvo caido dos horas, lo vencido durante ese rato sale ahora, no se pierde.
 */
export function schedulesDueForPublish(
  schedules: readonly DispatchableSchedule[],
  now: Date,
): DispatchableSchedule[] {
  return schedules.filter(
    (schedule) =>
      schedule.status === 'queued' && new Date(schedule.scheduled_at).getTime() <= now.getTime(),
  );
}

export interface DispatchOutcome {
  due: number;
  enqueued: number;
  /** Ya habia un trabajo vivo para esa programacion: lo rechazo la base. */
  alreadyQueued: number;
}

const UNIQUE_VIOLATION = '23505';

export async function enqueueDuePublishes(now: Date = new Date()): Promise<DispatchOutcome> {
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from('schedules')
    .select('id, organization_id, scheduled_at, status')
    .eq('status', 'queued')
    .lte('scheduled_at', now.toISOString())
    .order('scheduled_at')
    .limit(200);

  if (error !== null) {
    throw new Error(`No se pudieron leer las programaciones: ${error.message}`);
  }

  const due = schedulesDueForPublish(data ?? [], now);
  const outcome: DispatchOutcome = { due: due.length, enqueued: 0, alreadyQueued: 0 };

  for (const schedule of due) {
    const { error: insertError } = await supabase.from('jobs').insert({
      organization_id: schedule.organization_id,
      job_type: 'publish',
      payload: { schedule_id: schedule.id },
      // Publicar tarde pierde valor: un teaser programado para las diez de la
      // noche no sirve a las dos de la madrugada. Va por delante de la ingesta.
      priority: 50,
    });

    if (insertError === null) {
      outcome.enqueued += 1;
    } else if (insertError.code === UNIQUE_VIOLATION) {
      outcome.alreadyQueued += 1;
    } else {
      throw new Error(
        `No se pudo encolar la publicacion de ${schedule.id}: ${insertError.message}`,
      );
    }
  }

  return outcome;
}
