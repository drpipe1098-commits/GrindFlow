import { NextResponse, type NextRequest } from 'next/server';
import { storeCloudConnection } from '@/lib/connectors/connection';
import { exchangeCodeForTokens, getCurrentAccount } from '@/lib/connectors/dropbox';
import { verifyOAuthState } from '@/lib/connectors/oauth-state';
import { connectorEnv, publicEnv } from '@/lib/env';
import { getAuthContext, hasOrgRole } from '@/lib/auth';

/**
 * Retorno de Dropbox tras autorizar.
 *
 * Cuatro comprobaciones antes de tocar nada, y ninguna es prescindible:
 *
 *   1. El `state` lleva firma valida y no ha caducado.
 *   2. El nonce de la cookie coincide con el del `state`, de modo que un `state`
 *      capturado no vale desde otro navegador.
 *   3. Hay sesion y es la MISMA persona que inicio el flujo.
 *   4. Esa persona sigue pudiendo gestionar la organizacion.
 *
 * Sin la 1 y la 3, un tercero puede conseguir que una agencia conecte la nube
 * del atacante dentro de su propia organizacion, y a partir de ahi ve todo lo
 * que se ingiera.
 */
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

  // La persona pulso "cancelar" en la pantalla de Dropbox.
  if (params.get('error') !== null) {
    return backToPanel('cancelado');
  }

  const code = params.get('code');
  const state = params.get('state');
  if (code === null || state === null) {
    return backToPanel('respuesta_incompleta');
  }

  const payload = verifyOAuthState(state);
  if (payload === null || payload.provider !== 'dropbox') {
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
  const redirectUri = `${publicEnv().NEXT_PUBLIC_APP_URL.replace(/\/$/, '')}/api/conectores/dropbox/callback`;

  try {
    const tokens = await exchangeCodeForTokens({
      code,
      appKey: env.DROPBOX_APP_KEY,
      appSecret: env.DROPBOX_APP_SECRET,
      redirectUri,
    });

    // `exchangeCodeForTokens` ya garantiza que hay refresh token: sin el, la
    // conexion moriria en cuatro horas y el escaneo dejaria de funcionar esa
    // misma tarde.
    const account = await getCurrentAccount(tokens.accessToken);
    const carpeta = request.cookies.get('mv_oauth_carpeta')?.value ?? null;

    await storeCloudConnection({
      organizationId: payload.organizationId,
      provider: 'dropbox',
      label: account.displayName ?? account.email ?? 'Dropbox',
      accountEmail: account.email,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? '',
      expiresInSeconds: tokens.expiresInSeconds,
      scopes: tokens.scopes,
      rootFolderPath: carpeta,
      createdBy: context.user.id,
    });

    return backToPanel('conectado');
  } catch (error) {
    // El detalle no vuelve al navegador: puede contener fragmentos de la
    // respuesta del proveedor. Queda en el registro del servidor.
    console.error('[conectores] fallo el intercambio con Dropbox', error);
    return backToPanel('error_de_intercambio');
  }
}
