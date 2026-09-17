/**
 * Worker de ingesta desde la nube.
 *
 * En Node y no en Python, a diferencia de los workers de medios, por una razon
 * concreta: los refresh tokens se guardan con el formato de
 * `src/lib/crypto/secrets.ts` —AES-256-GCM, version en el prefijo y contexto
 * firmado— y un worker en Python necesitaria una segunda implementacion del
 * mismo formato criptografico. Dos implementaciones de un formato asi divergen
 * en silencio. Ademas esto es E/S pura: hablar HTTP y mover bytes, no CPU.
 *
 *   npx tsx src/workers/ingest/index.ts
 *
 * Toma trabajos con `public.claim_jobs`, que delega en `app.claim_jobs`: el
 * SKIP LOCKED y el backoff siguen viviendo en la base, asi que arrancar varias
 * copias no necesita coordinacion alguna.
 */
import type { JobRow } from '@/lib/database.types';
import { createServiceClient } from '@/lib/supabase/service';
import { handleIngest, type IngestPayload } from './ingest';
import { enqueueDueScans } from './scheduler';
import { handleScan, type ScanPayload } from './scan';

const WORKER_NAME = process.env.WORKER_NAME ?? `ingest-${process.pid}`;
const BATCH_SIZE = Number(process.env.INGEST_WORKER_BATCH_SIZE ?? '2');
const POLL_SECONDS = Number(process.env.INGEST_WORKER_POLL_SECONDS ?? '10');
/** Cada cuanto revisa el programador si toca escanear alguna conexion. */
const SCHEDULER_TICK_SECONDS = Number(process.env.SCHEDULER_TICK_SECONDS ?? '300');

let stopRequested = false;

function log(message: string, extra: Record<string, unknown> = {}): void {
  const detail = Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : '';
  console.warn(`${new Date().toISOString()} [${WORKER_NAME}] ${message}${detail}`);
}

async function runJob(job: JobRow): Promise<void> {
  switch (job.job_type) {
    case 'scan_cloud_folder': {
      const outcome = await handleScan(job.payload as unknown as ScanPayload);
      log('escaneo terminado', { job: job.id, ...outcome });
      return;
    }
    case 'ingest_cloud_file': {
      const outcome = await handleIngest(job.payload as unknown as IngestPayload);
      log('archivo procesado', { job: job.id, ...outcome });
      return;
    }
    default:
      throw new Error(`este worker no atiende trabajos de tipo ${job.job_type}`);
  }
}

async function tick(): Promise<number> {
  const supabase = createServiceClient();

  const { data: jobs, error } = await supabase.rpc('claim_jobs', {
    p_worker: WORKER_NAME,
    p_batch: BATCH_SIZE,
    p_types: ['scan_cloud_folder', 'ingest_cloud_file'],
  });

  if (error !== null) {
    log('no se pudo consultar la cola', { error: error.message });
    return 0;
  }

  const claimed = jobs ?? [];

  for (const job of claimed) {
    try {
      await runJob(job);
      await supabase.rpc('complete_job', { p_job_id: job.id, p_success: true });
    } catch (caught) {
      // Se captura todo a proposito: un archivo corrupto o una cuenta revocada
      // no deben tumbar el worker y dejar la cola entera sin consumir. La base
      // decide si reintentar con espera o darlo por muerto.
      const message = caught instanceof Error ? caught.message : String(caught);
      log('trabajo fallido', { job: job.id, error: message });
      await supabase.rpc('complete_job', {
        p_job_id: job.id,
        p_success: false,
        p_error: message.slice(0, 1000),
      });
    }
  }

  return claimed.length;
}

/**
 * Revision periodica del programador.
 *
 * Un fallo aqui no debe tumbar el worker: encolar escaneos es importante, pero
 * procesar los que ya estan en la cola lo es mas.
 */
async function schedulerTick(): Promise<void> {
  try {
    const outcome = await enqueueDueScans();
    if (outcome.enqueued > 0 || outcome.alreadyQueued > 0) {
      log('programador', { ...outcome });
    }
  } catch (error) {
    log('el programador fallo', {
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

  log('worker de ingesta en marcha', {
    lote: BATCH_SIZE,
    sondeo: POLL_SECONDS,
    programador: SCHEDULER_TICK_SECONDS,
  });

  // Primera pasada nada mas arrancar: si el worker estuvo caido, hay escaneos
  // atrasados y no tiene sentido esperar cinco minutos mas para verlos.
  await schedulerTick();
  let lastSchedulerRun = Date.now();

  while (!stopRequested) {
    if (Date.now() - lastSchedulerRun >= SCHEDULER_TICK_SECONDS * 1000) {
      await schedulerTick();
      lastSchedulerRun = Date.now();
    }

    const processed = await tick();

    // Solo se duerme cuando no habia nada que hacer. Con trabajo en la cola, se
    // sigue de largo: dormir con la cola llena multiplica la latencia de una
    // ingesta de cien archivos por el tiempo de sondeo.
    if (processed === 0 && !stopRequested) {
      await new Promise((resolve) => setTimeout(resolve, POLL_SECONDS * 1000));
    }
  }

  log('worker de ingesta detenido');
}

main().catch((error: unknown) => {
  log('fallo irrecuperable', { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
