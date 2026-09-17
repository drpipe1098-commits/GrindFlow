import 'server-only';

import type { Platform } from '@/lib/database.types';
import { blueskyPublisher, redditPublisher, xPublisher } from './pending';
import type { PlatformPublisher } from './publisher';
import { telegramPublisher } from './telegram';
import { webhookPublisher } from './webhook';

/**
 * Registro de publicadores.
 *
 * Es el unico punto del worker que sabe que destinos existen. El despachador
 * solo ve la interfaz, igual que `scan.ts` solo ve `CloudClient`.
 *
 * El tipo `Record<Platform, ...>` obliga a que esten TODOS: anadir un valor al
 * enum `platform` sin su publicador no compila. De ahi que los pendientes sean
 * objetos reales y no huecos.
 */
const PUBLISHERS: Record<Platform, PlatformPublisher> = {
  telegram: telegramPublisher,
  webhook: webhookPublisher,
  x: xPublisher,
  reddit: redditPublisher,
  bluesky: blueskyPublisher,
};

export function publisherFor(platform: Platform): PlatformPublisher {
  return PUBLISHERS[platform];
}

/** Destinos que hoy se pueden publicar de verdad. */
export function implementedPlatforms(): Platform[] {
  return (Object.keys(PUBLISHERS) as Platform[]).filter(
    (platform) => PUBLISHERS[platform].implemented,
  );
}
