/**
 * Worker de publicacion (Modulo 5).
 *
 * En Node, como el de ingesta y por lo mismo: los secretos de las plataformas se
 * descifran con `src/lib/crypto/secrets.ts`, y una segunda implementacion del
 * mismo formato AES-256-GCM en otro lenguaje acabaria divergiendo en silencio.
 *
 *   npx tsx --tsconfig tsconfig.workers.json src/workers/publish/index.ts
 *
 * Va separado del de ingesta a proposito. La ingesta mueve gigabytes durante
 * minutos; la publicacion son peticiones cortas con hora marcada. Juntos, una
 * descarga larga retrasaria un teaser programado para las diez de la noche.
 */
import { PublishError, decideRecovery } from '@/lib/publishing/errors';
import type { JobRow } from '@/lib/database.types';
import { createServiceClient } from '@/lib/supabase/service';
import { enqueueDuePublishes } from './dispatcher';
import { handlePublish, type PublishPayload } from './publish';

const WORKER_NAME = process.env.WORKER_NAME ?? `publish-${process.pid}`;
const BATCH_SIZE = Number(process.env.PUBLISH_WORKER_BATCH_SIZE ?? '3');
const POLL_SECONDS = Number(process.env.PUBLISH_WORKER_POLL_SECONDS ?? '15');
const DISPATCH_TICK_SECONDS = Number(process.env.PUBLISH_DISPATCH_SECONDS ?? '60');

let stopRequested = false;

function log(message: string, extra: Record<string, unknown> = {}): void {
  const detail = Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : '';
  console.warn(`${new Date().toISOString()} [${WORKER_NAME}] ${message}${detail}`);
}

/**
 * Aplica la decision de recuperacion.
 *
 * `decideRecovery` decide QUE hacer; esto lo ejecuta. La separacion permite
 * probar las reglas sin base ni red.
 */
async function recover(job: JobRow, error: unknown): Promise<void> {
  const supabase = createServiceClient();
  const publishError =
    error instanceof PublishError
      ? error
      : new PublishError(error instanceof Error ? error.message : String(error), 'transient');

  const decision = decideRecovery({
    kind: publishError.kind,
    attempt: job.attempts,
    retryAfterSeconds: publishError.retryAfterSeconds,
  });

  const message = publishError.message.slice(0, 1000);

  if (decision.action === 'defer') {
    log('aplazado', { job: job.id, clase: publishError.kind, segundos: decision.delaySeconds });
    await supabase.rpc('defer_job', {
      p_job_id: job.id,
      p_seconds: decision.delaySeconds,
      p_error: message,
    });
    return;
  }

  // A partir de aqui el trabajo no se reintenta, asi que la programacion queda
  // marcada como fallida y visible en el panel.
  const scheduleId = (job.payload as unknown as PublishPayload).schedule_id;
  const { data: schedule } = await supabase
    .from('schedules')
    .select('id, organization_id, profile_id, platform')
    .eq('id', scheduleId)
    .maybeSingle();

  if (schedule !== null) {
    await supabase
      .from('schedules')
      .update({ status: 'failed', published: false, last_error: message })
      .eq('id', schedule.id);
  }

  if (decision.action === 'suspend' && schedule !== null) {
    // Todas las publicaciones de ese perfil hacia esa red se paran. `until` en
    // nulo porque un token revocado no se arregla esperando: hace falta que
    // alguien reconecte la cuenta y levante la suspension.
    const { error: suspendError } = await supabase.from('publish_suspensions').insert({
      organization_id: schedule.organization_id,
      profile_id: schedule.profile_id,
      platform: schedule.platform,
      reason: 'credencial rechazada por la plataforma',
      last_error: message,
      until: null,
    });

    // 23505 significa que ya habia una suspension viva: es lo esperable cuando
    // varias publicaciones del mismo perfil fallan a la vez.
    if (suspendError !== null && suspendError.code !== '23505') {
      log('no se pudo registrar la suspension', { job: job.id, error: suspendError.message });
    } else {
      log('perfil suspendido en la red', {
        perfil: schedule.profile_id,
        red: schedule.platform,
      });
    }
  }

  await supabase.rpc('kill_job', { p_job_id: job.id, p_error: message });
}

async function tick(): Promise<number> {
  const supabase = createServiceClient();

  const { data: jobs, error } = await supabase.rpc('claim_jobs', {
    p_worker: WORKER_NAME,
    p_batch: BATCH_SIZE,
    p_types: ['publish'],
  });

  if (error !== null) {
    log('no se pudo consultar la cola', { error: error.message });
    return 0;
  }

  const claimed = jobs ?? [];

  for (const job of claimed) {
    try {
      const outcome = await handlePublish(job.payload as unknown as PublishPayload);
      log('publicado', { job: job.id, ...outcome });
      await supabase.rpc('complete_job', { p_job_id: job.id, p_success: true });
    } catch (caught) {
      log('publicacion fallida', {
        job: job.id,
        error: caught instanceof Error ? caught.message : String(caught),
      });
      await recover(job, caught);
    }
  }

  return claimed.length;
}

async function dispatchTick(): Promise<void> {
  try {
    const outcome = await enqueueDuePublishes();
    if (outcome.enqueued > 0 || outcome.alreadyQueued > 0) {
      log('despachador', { ...outcome });
    }
  } catch (error) {
    log('el despachador fallo', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function main(): Promise<void> {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      stopRequested = true;
      log(`senal ${signal} recibida: se saldra al terminar el trabajo actual`);
    });
  }

  log('worker de publicacion en marcha', {
    lote: BATCH_SIZE,
    sondeo: POLL_SECONDS,
    despachador: DISPATCH_TICK_SECONDS,
  });

  // Primera pasada al arrancar: si el worker estuvo caido, hay programaciones
  // vencidas esperando y no tiene sentido retrasarlas otro minuto.
  await dispatchTick();
  let lastDispatch = Date.now();

  while (!stopRequested) {
    if (Date.now() - lastDispatch >= DISPATCH_TICK_SECONDS * 1000) {
      await dispatchTick();
      lastDispatch = Date.now();
    }

    const processed = await tick();
    if (processed === 0 && !stopRequested) {
      await new Promise((resolve) => setTimeout(resolve, POLL_SECONDS * 1000));
    }
  }

  log('worker de publicacion detenido');
}

main().catch((error: unknown) => {
  log('fallo irrecuperable', { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
