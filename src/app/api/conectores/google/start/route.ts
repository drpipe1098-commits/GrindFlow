import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { buildAuthorizeUrl } from '@/lib/connectors/google-drive';
import { createOAuthState } from '@/lib/connectors/oauth-state';
import { connectorEnv, publicEnv } from '@/lib/env';
import { getAuthContext, hasOrgRole } from '@/lib/auth';

/**
 * Inicio del flujo OAuth2 con Google Drive.
 *
 * Mismas comprobaciones que el de Dropbox. Lo que cambia esta dentro de
 * `buildAuthorizeUrl`: alcance unico `drive.readonly`, `access_type=offline` y
 * `prompt=consent`, sin los cuales Google no entrega refresh token de forma
 * fiable.
 */
export const runtime = 'nodejs';

const querySchema = z.object({
  org: z.string().uuid(),
  /** Identificador de la carpeta de Drive. Drive usa ids opacos, no rutas. */
  carpeta: z.string().max(200).optional(),
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
  if (env.GOOGLE_CLIENT_ID === undefined) {
    return NextResponse.json({ error: 'google_no_configurado' }, { status: 501 });
  }

  const { state, nonce } = createOAuthState({
    organizationId: parsed.data.org,
    userId: context.user.id,
    provider: 'google_drive',
  });

  const redirectUri = `${publicEnv().NEXT_PUBLIC_APP_URL.replace(/\/$/, '')}/api/conectores/google/callback`;

  const response = NextResponse.redirect(
    buildAuthorizeUrl({ clientId: env.GOOGLE_CLIENT_ID, redirectUri, state }),
  );

  const cookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/api/conectores',
    maxAge: 600,
  };

  response.cookies.set('mv_oauth_nonce', nonce, cookieOptions);
  if (parsed.data.carpeta !== undefined && parsed.data.carpeta !== '') {
    response.cookies.set('mv_oauth_carpeta', parsed.data.carpeta, cookieOptions);
  }

  return response;
}
