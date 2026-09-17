'use server';

import { revalidatePath } from 'next/cache';
import { getAuthContext, hasOrgRole } from '@/lib/auth';
import { parseAssignRequest, summarizeAssignment, type AssignSummary } from '@/lib/connectors/triage';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';

/**
 * Asignacion en lote desde el panel de triaje.
 *
 * El reparto de responsabilidades entre los dos clientes de Supabase es lo
 * importante de esta funcion:
 *
 *   - El cambio de los items va con el cliente de SESION, sujeto a RLS. Es lo
 *     que garantiza que nadie asigne archivos de otra organizacion, y no depende
 *     de que la comprobacion de arriba sea correcta.
 *   - Encolar los trabajos necesita la clave de servicio, porque `jobs` no tiene
 *     politica de INSERT para clientes. Pero solo se encolan los identificadores
 *     que el UPDATE anterior DEVOLVIO: el cliente de servicio nunca actua sobre
 *     un id que el RLS no haya autorizado ya.
 *
 * Ese orden no es casual. Al reves —encolar primero y actualizar despues— una
 * peticion con ids ajenos encolaria descargas de material de otra agencia.
 */
export type AssignResult =
  | { ok: true; summary: AssignSummary }
  | { ok: false; error: string };

export async function assignItemsToProfile(input: unknown): Promise<AssignResult> {
  const parsed = parseAssignRequest(input);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }

  const context = await getAuthContext();
  if (context === null) {
    return { ok: false, error: 'sin_sesion' };
  }

  const supabase = await createClient();

  // El perfil destino decide la organizacion. Leerlo con el cliente de sesion ya
  // lo acota: un perfil de otra agencia sencillamente no aparece.
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, organization_id')
    .eq('id', parsed.request.profileId)
    .maybeSingle();

  if (profile === null) {
    return { ok: false, error: 'perfil_no_encontrado' };
  }

  if (!hasOrgRole(context, profile.organization_id, ['admin', 'studio', 'editor'])) {
    return { ok: false, error: 'sin_permiso' };
  }

  // `eq('status', 'unassigned')` evita pisar lo que otra persona ya asigno entre
  // que se cargo la pantalla y se pulso el boton.
  const { data: updated, error } = await supabase
    .from('cloud_ingest_items')
    .update({
      profile_id: profile.id,
      status: 'queued',
      assignment_source: 'manual',
      skip_reason: null,
    })
    .in('id', parsed.request.itemIds)
    .eq('status', 'unassigned')
    .eq('organization_id', profile.organization_id)
    .select('id, organization_id');

  if (error !== null) {
    return { ok: false, error: 'no_se_pudo_asignar' };
  }

  const assigned = updated ?? [];

  if (assigned.length > 0) {
    const service = createServiceClient();
    await service.from('jobs').insert(
      assigned.map((item) => ({
        organization_id: item.organization_id,
        job_type: 'ingest_cloud_file' as const,
        payload: { item_id: item.id },
      })),
    );
  }

  revalidatePath('/studio/triage');

  return {
    ok: true,
    summary: summarizeAssignment(parsed.request.itemIds.length, assigned.map((i) => i.id)),
  };
}
