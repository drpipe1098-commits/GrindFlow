import type { Platform } from '@/lib/database.types';
import { PublishError } from './errors';
import type { PlatformPublisher, PublishOutcome } from './publisher';

/**
 * Destinos esbozados pero sin implementar.
 *
 * Existen para que la arquitectura quede validada de verdad: el registro esta
 * completo, el despachador los encuentra y el sistema se comporta de forma
 * predecible al toparse con ellos, en vez de romperse con un `undefined` a la
 * hora de publicar.
 *
 * Fallan como 'permanent' a proposito. Reintentar cinco veces contra un
 * publicador que no existe solo retrasa el momento de enterarse, y deja la cola
 * ocupada mientras tanto.
 *
 * Lo que falta en cada uno no es el envio, que es una llamada HTTP, sino sus
 * reglas propias: X limita por nivel de acceso y exige marcar el contenido como
 * sensible; Reddit tiene reglas de flair, formato y frecuencia DISTINTAS EN CADA
 * subreddit, que es lo que de verdad cuesta modelar; Bluesky sube el medio en un
 * paso aparte antes de crear el post.
 */
function pendingPublisher(platform: Platform, missing: string): PlatformPublisher {
  return {
    platform,
    implemented: false,
    mediaDelivery: 'url',
    limits: { maxImageBytes: 0, maxVideoBytes: 0 },
    async publish(): Promise<PublishOutcome> {
      throw new PublishError(
        `El publicador de ${platform} todavia no esta implementado. Falta: ${missing}.`,
        'permanent',
      );
    },
  };
}

export const xPublisher = pendingPublisher(
  'x',
  'subida de medios en dos pasos, marcado de contenido sensible y cuotas por nivel de acceso',
);

export const redditPublisher = pendingPublisher(
  'reddit',
  'reglas por subreddit (flair obligatorio, formato y frecuencia) y eleccion de destino',
);

export const blueskyPublisher = pendingPublisher(
  'bluesky',
  'subida del blob y creacion del registro en el protocolo AT',
);
