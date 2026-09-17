/**
 * Pruebas del limitador de tasa y del hash de IP.
 *
 * El reloj entra por parametro en todas: una prueba de ventanas temporales que
 * dependiera del reloj real seria lenta y se volveria intermitente.
 */
import { describe, expect, it } from 'vitest';
import { FixedWindowRateLimiter, clientIp, hashIp } from '@/lib/rate-limit';

const T0 = 1_800_000_000_000;
const MINUTE = 60_000;

describe('ventana fija', () => {
  it('deja pasar hasta el limite', () => {
    const limiter = new FixedWindowRateLimiter(3, MINUTE);
    expect(limiter.check('ip', T0).allowed).toBe(true);
    expect(limiter.check('ip', T0 + 1).allowed).toBe(true);
    expect(limiter.check('ip', T0 + 2).allowed).toBe(true);
  });

  it('corta a partir del limite', () => {
    const limiter = new FixedWindowRateLimiter(3, MINUTE);
    for (let i = 0; i < 3; i += 1) limiter.check('ip', T0);
    expect(limiter.check('ip', T0).allowed).toBe(false);
    expect(limiter.check('ip', T0 + 100).allowed).toBe(false);
  });

  it('descuenta el restante en cada llamada', () => {
    const limiter = new FixedWindowRateLimiter(3, MINUTE);
    expect(limiter.check('ip', T0).remaining).toBe(2);
    expect(limiter.check('ip', T0).remaining).toBe(1);
    expect(limiter.check('ip', T0).remaining).toBe(0);
    expect(limiter.check('ip', T0).remaining).toBe(0);
  });

  it('reabre al cumplirse la ventana', () => {
    const limiter = new FixedWindowRateLimiter(2, MINUTE);
    limiter.check('ip', T0);
    limiter.check('ip', T0);
    expect(limiter.check('ip', T0 + MINUTE - 1).allowed).toBe(false);
    expect(limiter.check('ip', T0 + MINUTE).allowed).toBe(true);
  });

  it('mantiene el momento de reinicio estable dentro de la ventana', () => {
    const limiter = new FixedWindowRateLimiter(5, MINUTE);
    const primero = limiter.check('ip', T0).resetAt;
    expect(limiter.check('ip', T0 + 30_000).resetAt).toBe(primero);
    expect(primero).toBe(T0 + MINUTE);
  });

  it('cuenta cada clave por separado', () => {
    const limiter = new FixedWindowRateLimiter(1, MINUTE);
    expect(limiter.check('ip-a', T0).allowed).toBe(true);
    expect(limiter.check('ip-a', T0).allowed).toBe(false);
    // Bloquear a un visitante no debe bloquear a los demas.
    expect(limiter.check('ip-b', T0).allowed).toBe(true);
  });

  it('con limite 1 solo pasa la primera', () => {
    const limiter = new FixedWindowRateLimiter(1, MINUTE);
    expect(limiter.check('ip', T0).allowed).toBe(true);
    expect(limiter.check('ip', T0).allowed).toBe(false);
  });

  it('acota la memoria aunque lleguen claves siempre distintas', () => {
    // Sin tope, alguien con muchas IPs distintas haria crecer el mapa sin fin.
    const limiter = new FixedWindowRateLimiter(10, MINUTE, 100);
    for (let i = 0; i < 500; i += 1) {
      limiter.check(`ip-${i}`, T0);
    }
    expect(limiter.size).toBeLessThanOrEqual(100);
  });

  it('recicla las ventanas caducadas antes de vaciar', () => {
    const limiter = new FixedWindowRateLimiter(10, MINUTE, 50);
    for (let i = 0; i < 49; i += 1) limiter.check(`viejo-${i}`, T0);
    // Una ventana despues, las anteriores ya no sirven y dejan sitio.
    for (let i = 0; i < 49; i += 1) limiter.check(`nuevo-${i}`, T0 + MINUTE * 2);
    expect(limiter.size).toBeLessThanOrEqual(50);
    expect(limiter.check('nuevo-0', T0 + MINUTE * 2).allowed).toBe(true);
  });
});

describe('hash de IP', () => {
  it('produce un SHA-256 en hexadecimal', async () => {
    const hash = await hashIp('203.0.113.7', 'sal');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('es estable para la misma IP y la misma sal', async () => {
    expect(await hashIp('203.0.113.7', 'sal')).toBe(await hashIp('203.0.113.7', 'sal'));
  });

  it('cambia con la IP', async () => {
    expect(await hashIp('203.0.113.7', 'sal')).not.toBe(await hashIp('203.0.113.8', 'sal'));
  });

  it('cambia con la sal', async () => {
    // Por eso rotar CLICK_IP_SALT reinicia las ventanas en curso.
    expect(await hashIp('203.0.113.7', 'sal-a')).not.toBe(
      await hashIp('203.0.113.7', 'sal-b'),
    );
  });

  it('no contiene la IP original', async () => {
    const hash = await hashIp('203.0.113.7', 'sal');
    expect(hash).not.toContain('203');
    expect(hash).not.toContain('113');
  });
});

describe('extraccion de la IP del cliente', () => {
  it('toma el primer valor de X-Forwarded-For', () => {
    const headers = new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1, 10.0.0.2' });
    expect(clientIp(headers)).toBe('203.0.113.7');
  });

  it('tolera espacios sobrantes', () => {
    expect(clientIp(new Headers({ 'x-forwarded-for': '  203.0.113.7  ' }))).toBe('203.0.113.7');
  });

  it('cae en X-Real-IP si no hay X-Forwarded-For', () => {
    expect(clientIp(new Headers({ 'x-real-ip': '203.0.113.9' }))).toBe('203.0.113.9');
  });

  it('devuelve un marcador si no hay ninguna cabecera', () => {
    expect(clientIp(new Headers())).toBe('desconocida');
  });

  it('no devuelve cadena vacia con una cabecera vacia', () => {
    expect(clientIp(new Headers({ 'x-forwarded-for': '' }))).toBe('desconocida');
  });
});
