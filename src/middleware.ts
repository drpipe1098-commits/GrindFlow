import createIntlMiddleware from 'next-intl/middleware';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextFetchEvent, type NextRequest } from 'next/server';
import { routing } from '@/i18n/routing';
import { FixedWindowRateLimiter, clientIp, hashIp } from '@/lib/rate-limit';

/**
 * Middleware unico del proyecto. Atiende tres cosas, en este orden:
 *
 *   1. El redirector de enlaces cortos (/l/[slug]). Va primero y sale antes de
 *      tocar nada de i18n o de sesion: es trafico anonimo y masivo que no debe
 *      pagar el coste de lo demas.
 *   2. El enrutado de idioma (es por defecto, /en para ingles).
 *   3. El refresco de la sesion de Supabase, para que las cookies lleguen vivas
 *      a los Server Components.
 */

const intlMiddleware = createIntlMiddleware(routing);

const SLUG_PATTERN = /^[a-zA-Z0-9_-]{4,64}$/;

/**
 * Primera barrera contra la inflacion de contadores: corta las rafagas en el
 * borde, antes de que lleguen a la base.
 *
 * No es la barrera autoritativa. Vive en la memoria de este proceso, asi que con
 * varias replicas de `web` el limite efectivo se multiplica por el numero de
 * replicas, y ademas se puede rodear llamando al RPC directamente. La barrera
 * que de verdad cuenta es la de PostgreSQL, en `record_link_click`, que descarta
 * clics repetidos de la misma IP sobre el mismo enlace dentro de una ventana.
 * Esta solo evita el trabajo inutil.
 */
const clickLimiter = new FixedWindowRateLimiter(
  Number(process.env.CLICK_RATE_LIMIT_PER_MINUTE ?? '30'),
  60_000,
);

/** Familia del navegador a partir del User-Agent. */
function uaFamily(userAgent: string | null): string {
  if (userAgent === null) return 'desconocido';
  if (/bot|crawler|spider|preview/i.test(userAgent)) return 'bot';
  if (/Telegram/i.test(userAgent)) return 'Telegram';
  if (/Edg\//.test(userAgent)) return 'Edge';
  if (/OPR\//.test(userAgent)) return 'Opera';
  if (/Firefox\//.test(userAgent)) return 'Firefox';
  if (/Chrome\//.test(userAgent)) return 'Chrome';
  if (/Safari\//.test(userAgent)) return 'Safari';
  return 'otro';
}

/**
 * Resuelve el destino y redirige. La analitica se escribe DESPUES de responder,
 * dentro de `waitUntil`: el visitante no espera a que se registre su clic, y si
 * la escritura falla el redirector sigue funcionando. Perder una metrica es
 * molesto; perder una conversion, no.
 */
async function handleShortLink(
  request: NextRequest,
  event: NextFetchEvent,
): Promise<NextResponse> {
  const slug = decodeURIComponent(request.nextUrl.pathname.slice('/l/'.length));
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';

  const notFound = () => {
    const url = request.nextUrl.clone();
    url.pathname = '/';
    url.searchParams.set('enlace', 'no-encontrado');
    return NextResponse.redirect(url, 302);
  };

  if (!SLUG_PATTERN.test(slug) || supabaseUrl === '' || anonKey === '') {
    return notFound();
  }

  const rpc = (fn: string, body: unknown) =>
    fetch(`${supabaseUrl}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      cache: 'no-store',
    });

  let destination: string | null = null;
  try {
    const response = await rpc('resolve_tracking_link', { p_slug: slug });
    if (response.ok) {
      const rows = (await response.json()) as { destination_url: string }[];
      destination = rows[0]?.destination_url ?? null;
    }
  } catch {
    destination = null;
  }

  if (destination === null) {
    return notFound();
  }

  // El registro va en waitUntil: el visitante ya tiene su redireccion y no espera
  // a que se cuente el clic. Perder una metrica es molesto; perder una conversion,
  // no. Que ademas se limite la tasa aqui es un ahorro, no la garantia.
  event.waitUntil(
    (async () => {
      const salt = process.env.CLICK_IP_SALT ?? '';
      const ip = clientIp(request.headers);

      // Sin sal configurada no se calcula ningun hash. Enviar la IP en claro
      // seria peor que no limitar: el proposito es no guardarla nunca.
      const ipHash = salt === '' ? null : await hashIp(ip, salt);

      if (ipHash !== null && !clickLimiter.check(ipHash).allowed) {
        return;
      }

      await rpc('record_link_click', {
        p_slug: slug,
        p_country:
          request.headers.get('x-vercel-ip-country') ??
          request.headers.get('cf-ipcountry'),
        p_referrer: request.headers.get('referer'),
        p_ua_family: uaFamily(request.headers.get('user-agent')),
        p_ip_hash: ipHash,
      }).catch(() => undefined);
    })(),
  );

  // 302 y sin cache: un 301 lo guardaria el navegador y los clics siguientes
  // dejarian de contarse, ademas de impedir cambiar el destino del enlace.
  const redirect = NextResponse.redirect(destination, 302);
  redirect.headers.set('Cache-Control', 'no-store, max-age=0');
  redirect.headers.set('Referrer-Policy', 'no-referrer');
  return redirect;
}

/**
 * Renueva la sesion de Supabase. Los tokens se refrescan aqui y las cookies
 * nuevas se adjuntan a la respuesta que ya preparo el middleware de idioma.
 */
async function refreshSession(
  request: NextRequest,
  response: NextResponse,
): Promise<void> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (supabaseUrl === undefined || anonKey === undefined) return;

  const supabase = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  await supabase.auth.getUser();
}

export async function middleware(request: NextRequest, event: NextFetchEvent) {
  if (request.nextUrl.pathname.startsWith('/l/')) {
    return handleShortLink(request, event);
  }

  const response = intlMiddleware(request);
  await refreshSession(request, response);
  return response;
}

export const config = {
  matcher: [
    // Todo salvo los internos de Next, la API y los archivos con extension.
    '/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)',
    '/l/:slug*',
  ],
};
