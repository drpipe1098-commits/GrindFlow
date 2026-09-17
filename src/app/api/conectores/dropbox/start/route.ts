import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { buildAuthorizeUrl } from '@/lib/connectors/dropbox';
import { createOAuthState } from '@/lib/connectors/oauth-state';
import { connectorEnv, publicEnv } from '@/lib/env';
import { getAuthContext, hasOrgRole } from '@/lib/auth';

/**
 * Inicio del flujo OAuth2 con Dropbox.
 *
 * Solo admin o estudio: conectar una nube entrega a la plataforma un token que
 * ve toda la carpeta autorizada. El editor, que es quien mas trabaja con
 * material, queda fuera igual que en las credenciales de publicacion.
 */
export const runtime = 'nodejs';

const querySchema = z.object({
  org: z.string().uuid(),
  /** Carpeta a escanear. Vacio o ausente significa la raiz de la cuenta. */
  carpeta: z.string().max(500).optional(),
});

export async function GET(request: NextRequest) {
  const context = await getAuthContext();
  if (context === null) {
    return NextResponse.json({ error: 'sin_sesion' }, { status: 401 });
  }

  const parsed = querySchema.safeParse({
    org: request.nextUrl.searchParams.get('org') ?? undefined,
    carpeta: request.nextUrl.searchParams.get('carpeta') ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json({ error: 'parametros_invalidos' }, { status: 400 });
  }

  if (!hasOrgRole(context, parsed.data.org, ['admin', 'studio'])) {
    return NextResponse.json({ error: 'sin_permiso' }, { status: 403 });
  }

  const env = connectorEnv();
  const { state, nonce } = createOAuthState({
    organizationId: parsed.data.org,
    userId: context.user.id,
    provider: 'dropbox',
  });

  const redirectUri = `${publicEnv().NEXT_PUBLIC_APP_URL.replace(/\/$/, '')}/api/conectores/dropbox/callback`;

  const response = NextResponse.redirect(
    buildAuthorizeUrl({ appKey: env.DROPBOX_APP_KEY, redirectUri, state }),
  );

  // El nonce viaja tambien en una cookie httpOnly. El `state` firmado ya impide
  // fabricar uno valido; esto ademas impide REUTILIZAR uno capturado desde otro
  // navegador, porque sin la cookie no se puede completar el flujo.
  response.cookies.set('gf_oauth_nonce', nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/api/conectores',
    maxAge: 600,
  });

  // La carpeta elegida se recuerda aparte: no cabe en el `state` sin alargarlo.
  if (parsed.data.carpeta !== undefined && parsed.data.carpeta !== '') {
    response.cookies.set('gf_oauth_carpeta', parsed.data.carpeta, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/api/conectores',
      maxAge: 600,
    });
  }

  return response;
}
