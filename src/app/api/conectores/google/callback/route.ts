import { NextResponse, type NextRequest } from 'next/server';
import { storeCloudConnection } from '@/lib/connectors/connection';
import { exchangeCodeForTokens, getCurrentAccount } from '@/lib/connectors/google-drive';
import { verifyOAuthState } from '@/lib/connectors/oauth-state';
import { connectorEnv, publicEnv } from '@/lib/env';
import { getAuthContext, hasOrgRole } from '@/lib/auth';

/** Retorno de Google. Mismas cuatro comprobaciones que el de Dropbox. */
export const runtime = 'nodejs';

function backToPanel(result: string): NextResponse {
  const base = publicEnv().NEXT_PUBLIC_APP_URL.replace(/\/$/, '');
  const response = NextResponse.redirect(`${base}/studio/conectores?resultado=${result}`);
  response.cookies.delete('mv_oauth_nonce');
  response.cookies.delete('mv_oauth_carpeta');
  return response;
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;

  if (params.get('error') !== null) {
    return backToPanel('cancelado');
  }

  const code = params.get('code');
  const state = params.get('state');
  if (code === null || state === null) {
    return backToPanel('respuesta_incompleta');
  }

  const payload = verifyOAuthState(state);
  if (payload === null || payload.provider !== 'google_drive') {
    return backToPanel('state_invalido');
  }

  const cookieNonce = request.cookies.get('mv_oauth_nonce')?.value;
  if (cookieNonce === undefined || cookieNonce !== payload.nonce) {
    return backToPanel('state_invalido');
  }

  const context = await getAuthContext();
  if (context === null || context.user.id !== payload.userId) {
    return backToPanel('sesion_distinta');
  }

  if (!hasOrgRole(context, payload.organizationId, ['admin', 'studio'])) {
    return backToPanel('sin_permiso');
  }

  const env = connectorEnv();
  if (env.GOOGLE_CLIENT_ID === undefined || env.GOOGLE_CLIENT_SECRET === undefined) {
    return backToPanel('google_no_configurado');
  }

  const redirectUri = `${publicEnv().NEXT_PUBLIC_APP_URL.replace(/\/$/, '')}/api/conectores/google/callback`;

  try {
    const tokens = await exchangeCodeForTokens({
      code,
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      redirectUri,
    });

    const account = await getCurrentAccount(tokens.accessToken);

    await storeCloudConnection({
      organizationId: payload.organizationId,
      provider: 'google_drive',
      label: account.displayName ?? account.email ?? 'Google Drive',
      accountEmail: account.email,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? '',
      expiresInSeconds: tokens.expiresInSeconds,
      scopes: tokens.scopes,
      // Drive identifica las carpetas por id opaco, no por ruta.
      rootFolderId: request.cookies.get('mv_oauth_carpeta')?.value ?? null,
      rootFolderPath: null,
      createdBy: context.user.id,
    });

    return backToPanel('conectado');
  } catch (error) {
    console.error('[conectores] fallo el intercambio con Google', error);
    return backToPanel('error_de_intercambio');
  }
}
