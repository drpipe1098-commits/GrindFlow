import { z } from 'zod';

/**
 * Reglas de la asignacion en lote del panel de triaje.
 *
 * Codigo puro y sin dependencias del servidor, para poder probarlo sin montar
 * una base ni una sesion.
 */

/**
 * Tope de archivos por lote.
 *
 * Existe por dos razones distintas. Una: cada asignacion encola un trabajo de
 * descarga, y mil de golpe dejan la cola sin margen para nada mas durante horas.
 * Dos: acota el coste de una peticion maliciosa, porque el tamano del lote lo
 * elige el cliente.
 */
export const MAX_BATCH = 200;

export const assignRequestSchema = z.object({
  itemIds: z.array(z.string().uuid()).min(1).max(MAX_BATCH),
  profileId: z.string().uuid(),
});

export type AssignRequest = z.infer<typeof assignRequestSchema>;

export type AssignParseResult =
  | { ok: true; request: AssignRequest; duplicatesRemoved: number }
  | { ok: false; error: 'sin_seleccion' | 'lote_demasiado_grande' | 'datos_invalidos' };

/**
 * Valida y normaliza lo que llega del formulario.
 *
 * Quita los identificadores repetidos antes de comprobar el tope: una interfaz
 * con un fallo de seleccion puede mandar el mismo archivo varias veces, y
 * rechazar el lote por un duplicado seria un error de cara a quien lo usa.
 */
export function parseAssignRequest(input: unknown): AssignParseResult {
  const shallow = z
    .object({ itemIds: z.array(z.string()), profileId: z.string() })
    .safeParse(input);

  if (!shallow.success) {
    return { ok: false, error: 'datos_invalidos' };
  }

  const unique = [...new Set(shallow.data.itemIds)];
  const duplicatesRemoved = shallow.data.itemIds.length - unique.length;

  if (unique.length === 0) {
    return { ok: false, error: 'sin_seleccion' };
  }

  if (unique.length > MAX_BATCH) {
    return { ok: false, error: 'lote_demasiado_grande' };
  }

  const parsed = assignRequestSchema.safeParse({
    itemIds: unique,
    profileId: shallow.data.profileId,
  });

  if (!parsed.success) {
    return { ok: false, error: 'datos_invalidos' };
  }

  return { ok: true, request: parsed.data, duplicatesRemoved };
}

export interface AssignSummary {
  /** Cuantos se pidieron, ya sin repetidos. */
  requested: number;
  /** Cuantos cambio realmente la base. */
  assigned: number;
  /**
   * Pedidos que no se tocaron. Pasa cuando otra persona los asigno mientras
   * tanto, o cuando eran de otra organizacion y el RLS los dejo fuera.
   */
  untouched: number;
}

export function summarizeAssignment(requested: number, assignedIds: readonly string[]): AssignSummary {
  return {
    requested,
    assigned: assignedIds.length,
    untouched: requested - assignedIds.length,
  };
}
