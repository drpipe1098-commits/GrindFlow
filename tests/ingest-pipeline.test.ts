/**
 * Pruebas del programador, del triaje y de la URL de autorizacion de Google.
 */
import { describe, expect, it } from 'vitest';
import {
  connectionsDueForScan,
  isDueForScan,
  type SchedulableConnection,
} from '@/workers/ingest/scheduler';
import {
  MAX_BATCH,
  parseAssignRequest,
  summarizeAssignment,
} from '@/lib/connectors/triage';
import { DRIVE_SCOPE, buildAuthorizeUrl } from '@/lib/connectors/google-drive';

const AHORA = new Date('2026-04-01T12:00:00Z');

const conexion = (overrides: Partial<SchedulableConnection> = {}): SchedulableConnection => ({
  id: 'c-1',
  organization_id: 'org-1',
  status: 'active',
  scan_enabled: true,
  scan_interval_minutes: 30,
  last_scan_at: '2026-04-01T11:00:00Z',
  ...overrides,
});

describe('cadencia de escaneo', () => {
  it('escanea una conexion recien creada de inmediato', () => {
    // Esperar media hora tras conectar deja a la persona mirando una lista vacia
    // sin saber si la conexion funciono.
    expect(isDueForScan(conexion({ last_scan_at: null }), AHORA)).toBe(true);
  });

  it('no escanea antes de cumplirse el intervalo', () => {
    const reciente = conexion({ last_scan_at: '2026-04-01T11:45:00Z' });
    expect(isDueForScan(reciente, AHORA)).toBe(false);
  });

  it('escanea justo al cumplirse el intervalo', () => {
    const justo = conexion({ last_scan_at: '2026-04-01T11:30:00Z' });
    expect(isDueForScan(justo, AHORA)).toBe(true);
  });

  it('respeta el intervalo propio de cada conexion', () => {
    // Un archivo historico que no cambia desde 2023 no necesita que lo miren
    // cuarenta y ocho veces al dia.
    const diaria = conexion({ scan_interval_minutes: 1440, last_scan_at: '2026-04-01T06:00:00Z' });
    expect(isDueForScan(diaria, AHORA)).toBe(false);

    const rapida = conexion({ scan_interval_minutes: 5, last_scan_at: '2026-04-01T11:50:00Z' });
    expect(isDueForScan(rapida, AHORA)).toBe(true);
  });

  it('no escanea una conexion pausada', () => {
    // Pausar no es desconectar: se conserva el cursor y los tokens.
    expect(isDueForScan(conexion({ scan_enabled: false, last_scan_at: null }), AHORA)).toBe(false);
  });

  it('no escanea una conexion caducada o con error', () => {
    expect(isDueForScan(conexion({ status: 'expired', last_scan_at: null }), AHORA)).toBe(false);
    expect(isDueForScan(conexion({ status: 'revoked', last_scan_at: null }), AHORA)).toBe(false);
    expect(isDueForScan(conexion({ status: 'error', last_scan_at: null }), AHORA)).toBe(false);
  });

  it('filtra la lista dejando solo las que tocan', () => {
    const lista = [
      conexion({ id: 'a', last_scan_at: null }),
      conexion({ id: 'b', last_scan_at: '2026-04-01T11:59:00Z' }),
      conexion({ id: 'c', last_scan_at: '2026-04-01T09:00:00Z' }),
      conexion({ id: 'd', scan_enabled: false, last_scan_at: null }),
    ];

    expect(connectionsDueForScan(lista, AHORA).map((c) => c.id)).toEqual(['a', 'c']);
  });

  it('con la lista vacia no propone nada', () => {
    expect(connectionsDueForScan([], AHORA)).toEqual([]);
  });
});

describe('asignacion en lote del triaje', () => {
  const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

  it('acepta una seleccion valida', () => {
    const result = parseAssignRequest({ itemIds: [id(1), id(2)], profileId: id(9) });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.itemIds).toHaveLength(2);
      expect(result.duplicatesRemoved).toBe(0);
    }
  });

  it('quita los repetidos en vez de rechazar el lote', () => {
    // Un fallo de seleccion en la interfaz no deberia costarle el lote entero a
    // quien esta haciendo el triaje.
    const result = parseAssignRequest({ itemIds: [id(1), id(1), id(2)], profileId: id(9) });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.itemIds).toEqual([id(1), id(2)]);
      expect(result.duplicatesRemoved).toBe(1);
    }
  });

  it('rechaza una seleccion vacia', () => {
    const result = parseAssignRequest({ itemIds: [], profileId: id(9) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('sin_seleccion');
  });

  it('rechaza un lote por encima del tope', () => {
    // El tamano del lote lo elige el cliente: sin tope, una peticion encola mil
    // descargas y deja la cola sin margen durante horas.
    const muchos = Array.from({ length: MAX_BATCH + 1 }, (_, i) => id(i + 1));
    const result = parseAssignRequest({ itemIds: muchos, profileId: id(9) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('lote_demasiado_grande');
  });

  it('acepta justo el tope', () => {
    const justos = Array.from({ length: MAX_BATCH }, (_, i) => id(i + 1));
    expect(parseAssignRequest({ itemIds: justos, profileId: id(9) }).ok).toBe(true);
  });

  it('cuenta los repetidos antes de aplicar el tope', () => {
    const conRepetidos = [
      ...Array.from({ length: MAX_BATCH }, (_, i) => id(i + 1)),
      id(1),
      id(2),
    ];
    expect(parseAssignRequest({ itemIds: conRepetidos, profileId: id(9) }).ok).toBe(true);
  });

  it('rechaza identificadores que no son UUID', () => {
    const result = parseAssignRequest({ itemIds: ['no-es-uuid'], profileId: id(9) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('datos_invalidos');
  });

  it('rechaza una entrada con la forma equivocada', () => {
    expect(parseAssignRequest(null).ok).toBe(false);
    expect(parseAssignRequest({ itemIds: 'no-es-lista', profileId: id(9) }).ok).toBe(false);
    expect(parseAssignRequest({ itemIds: [id(1)] }).ok).toBe(false);
  });

  it('resume lo pedido frente a lo realmente cambiado', () => {
    // La diferencia aparece cuando otra persona asigno esos archivos entre que
    // se cargo la pantalla y se pulso el boton.
    const resumen = summarizeAssignment(5, ['a', 'b', 'c']);
    expect(resumen).toEqual({ requested: 5, assigned: 3, untouched: 2 });
  });

  it('resume correctamente cuando no se cambio nada', () => {
    expect(summarizeAssignment(3, [])).toEqual({ requested: 3, assigned: 0, untouched: 3 });
  });
});

describe('autorizacion de Google Drive', () => {
  const url = new URL(
    buildAuthorizeUrl({
      clientId: 'cliente-123',
      redirectUri: 'https://panel.test/api/conectores/google/callback',
      state: 'estado-firmado',
    }),
  );

  it('pide un unico alcance, y de solo lectura', () => {
    // Principio de menor privilegio: `drive` daria escritura sobre todo el Drive
    // de la persona para una funcion que solo necesita leer.
    expect(url.searchParams.get('scope')).toBe(DRIVE_SCOPE);
    expect(DRIVE_SCOPE).toContain('drive.readonly');
    expect(url.searchParams.get('scope')).not.toContain(' ');
  });

  it('pide acceso sin conexion', () => {
    // Sin esto no hay refresh token y la conexion muere en una hora.
    expect(url.searchParams.get('access_type')).toBe('offline');
  });

  it('fuerza el consentimiento', () => {
    // Google entrega el refresh token SOLO la primera vez que una cuenta
    // autoriza. Sin forzarlo, una reconexion nace muerta sin ningun error.
    expect(url.searchParams.get('prompt')).toBe('consent');
  });

  it('lleva el state firmado y la URI de retorno exacta', () => {
    expect(url.searchParams.get('state')).toBe('estado-firmado');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://panel.test/api/conectores/google/callback',
    );
    expect(url.searchParams.get('response_type')).toBe('code');
  });

  it('apunta al servidor de autorizacion de Google', () => {
    expect(url.origin).toBe('https://accounts.google.com');
  });
});
