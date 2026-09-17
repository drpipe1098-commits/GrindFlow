/**
 * Limitador de tasa por ventana fija, en memoria del proceso.
 *
 * Es la primera de las dos barreras del acortador. Corta las rafagas antes de
 * que toquen la base, que es lo caro. La barrera autoritativa es la segunda, en
 * PostgreSQL (`record_link_click` descarta clics repetidos de la misma IP sobre
 * el mismo enlace dentro de una ventana), y esa si es comun a todas las replicas.
 *
 * Los limites de este modulo:
 *
 *   - Es por proceso. Con cuatro contenedores de `web`, el limite efectivo es
 *     cuatro veces el configurado. Por eso no puede ser la unica barrera.
 *   - Se pierde al reiniciar. Aceptable: la ventana dura un minuto.
 *
 * Ventana fija y no deslizante a proposito. La deslizante es mas justa en el
 * borde, pero exige guardar cada marca de tiempo; la fija guarda un entero por
 * clave. Para descartar rafagas, la diferencia no se nota.
 *
 * El reloj entra por parametro para que las pruebas no dependan del real.
 */

interface Window {
  count: number;
  resetAt: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Peticiones que aun caben en la ventana actual. */
  remaining: number;
  /** Momento en que la ventana se reinicia. */
  resetAt: number;
}

export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    /** Tope de claves vivas. Sin el, un atacante con IPs variadas agota la memoria. */
    private readonly maxKeys = 50_000,
  ) {}

  check(key: string, now: number = Date.now()): RateLimitResult {
    const existing = this.windows.get(key);

    if (existing === undefined || now >= existing.resetAt) {
      const resetAt = now + this.windowMs;
      this.evictIfNeeded(now);
      this.windows.set(key, { count: 1, resetAt });
      return { allowed: true, remaining: this.limit - 1, resetAt };
    }

    if (existing.count >= this.limit) {
      return { allowed: false, remaining: 0, resetAt: existing.resetAt };
    }

    existing.count += 1;
    return {
      allowed: true,
      remaining: this.limit - existing.count,
      resetAt: existing.resetAt,
    };
  }

  /**
   * Limpia ventanas caducadas y, si aun asi se supera el tope, vacia el mapa.
   *
   * Vaciar entero es brusco pero acotado y predecible: perdona un minuto de
   * cuentas en el peor caso. La alternativa —desalojar por antiguedad— exige
   * mantener orden y no compensa para lo que hace esto.
   */
  private evictIfNeeded(now: number): void {
    if (this.windows.size < this.maxKeys) return;

    for (const [key, window] of this.windows) {
      if (now >= window.resetAt) this.windows.delete(key);
    }

    if (this.windows.size >= this.maxKeys) {
      this.windows.clear();
    }
  }

  /** Solo para pruebas y diagnostico. */
  get size(): number {
    return this.windows.size;
  }
}

/**
 * Hash de la IP con una sal del entorno.
 *
 * Nunca se guarda una IP en claro: ni en la base ni en los registros. El hash
 * basta para contar y limitar, y como la sal vive en el entorno, un volcado de
 * la base no permite recuperar las direcciones ni siquiera probando el espacio
 * entero de IPv4.
 *
 * Usa Web Crypto y no `node:crypto` porque esto corre en el middleware, que se
 * ejecuta en el runtime del borde.
 */
export async function hashIp(ip: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}:${ip}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * IP del cliente detras de un proxy inverso.
 *
 * El primer valor de X-Forwarded-For es el cliente original; los siguientes son
 * los saltos intermedios. Ojo: la cabecera la puede falsificar quien llame
 * directamente al contenedor, asi que en el VPS el proxy (Caddy o Traefik) tiene
 * que reescribirla y `web` no debe quedar expuesto al exterior.
 */
export function clientIp(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded !== null) {
    const first = forwarded.split(',')[0]?.trim();
    if (first !== undefined && first.length > 0) return first;
  }
  return headers.get('x-real-ip') ?? 'desconocida';
}
