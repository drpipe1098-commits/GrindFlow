/**
 * Pruebas de la matematica del motor anti-repeticion.
 *
 * Todas usan fechas fijas y absolutas en UTC. Ninguna llama a `new Date()` sin
 * argumentos: una prueba que dependa del reloj real falla sola algun martes y
 * nadie sabe por que.
 *
 * El enfasis esta en las fronteras. Un enfriamiento de 30 dias es facil de
 * acertar en el caso obvio y facil de errar por un milisegundo justo en el
 * limite, que es donde de verdad se decide si el asset se repite antes de tiempo.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RULES,
  evaluateCandidate,
  planQueue,
  selectNextAsset,
  startOfUtcDay,
  type CandidateAsset,
  type PublicationRecord,
  type SchedulingRules,
} from '@/lib/scheduling/hard-rule';

const utc = (iso: string): Date => new Date(iso);

const DAY = 86_400_000;
const MINUTE = 60_000;

const rules = (overrides: Partial<SchedulingRules> = {}): SchedulingRules => ({
  ...DEFAULT_RULES,
  ...overrides,
});

const asset = (
  id: string,
  outfitTag: string | null = null,
  createdAt = utc('2026-01-01T00:00:00Z'),
): CandidateAsset => ({ id, outfitTag, createdAt });

const published = (
  assetId: string,
  scheduledAt: string,
  outfitTag: string | null = null,
  platform: PublicationRecord['platform'] = 'telegram',
): PublicationRecord => ({
  assetId,
  outfitTag,
  platform,
  scheduledAt: utc(scheduledAt),
});

describe('enfriamiento del asset', () => {
  it('acepta un asset que nunca se publico', () => {
    const result = evaluateCandidate(asset('a1'), {
      at: utc('2026-04-01T12:00:00Z'),
      platform: 'telegram',
      rules: rules(),
      history: [],
    });

    expect(result.eligible).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.availableAt).toBeNull();
  });

  it('bloquea un asset republicado antes de cumplir los X dias', () => {
    const result = evaluateCandidate(asset('a1'), {
      at: utc('2026-04-01T12:00:00Z'),
      platform: 'telegram',
      rules: rules({ assetCooldownDays: 30 }),
      history: [published('a1', '2026-03-20T12:00:00Z')],
    });

    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual(['asset_cooldown']);
    // 20 de marzo + 30 dias = 19 de abril, misma hora.
    expect(result.availableAt?.toISOString()).toBe('2026-04-19T12:00:00.000Z');
  });

  it('libera el asset exactamente al cumplirse el plazo', () => {
    const last = utc('2026-03-01T08:30:00Z');
    const result = evaluateCandidate(asset('a1'), {
      at: new Date(last.getTime() + 30 * DAY),
      platform: 'telegram',
      rules: rules({ assetCooldownDays: 30 }),
      history: [published('a1', last.toISOString())],
    });

    expect(result.eligible).toBe(true);
  });

  it('sigue bloqueado un milisegundo antes del plazo', () => {
    const last = utc('2026-03-01T08:30:00Z');
    const result = evaluateCandidate(asset('a1'), {
      at: new Date(last.getTime() + 30 * DAY - 1),
      platform: 'telegram',
      rules: rules({ assetCooldownDays: 30 }),
      history: [published('a1', last.toISOString())],
    });

    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('asset_cooldown');
  });

  it('con enfriamiento de 0 dias no bloquea nada', () => {
    const result = evaluateCandidate(asset('a1'), {
      at: utc('2026-03-01T08:30:01Z'),
      platform: 'telegram',
      rules: rules({ assetCooldownDays: 0, minGapMinutes: 0 }),
      history: [published('a1', '2026-03-01T08:30:00Z')],
    });

    expect(result.eligible).toBe(true);
  });

  it('cuenta la reutilizacion aunque haya sido en otra plataforma', () => {
    // El publico de X y el de Telegram se solapan: repetir ahi tambien es repetir.
    const result = evaluateCandidate(asset('a1'), {
      at: utc('2026-03-05T00:00:00Z'),
      platform: 'telegram',
      rules: rules({ assetCooldownDays: 30 }),
      history: [published('a1', '2026-03-01T00:00:00Z', null, 'x')],
    });

    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('asset_cooldown');
  });

  it('toma la reutilizacion mas reciente cuando hay varias', () => {
    const result = evaluateCandidate(asset('a1'), {
      at: utc('2026-04-01T00:00:00Z'),
      platform: 'telegram',
      rules: rules({ assetCooldownDays: 10 }),
      history: [
        published('a1', '2026-01-01T00:00:00Z'),
        published('a1', '2026-03-28T00:00:00Z'),
        published('a1', '2026-02-15T00:00:00Z'),
      ],
    });

    expect(result.availableAt?.toISOString()).toBe('2026-04-07T00:00:00.000Z');
  });
});

describe('enfriamiento de la prenda', () => {
  it('bloquea otro asset de la misma prenda dentro de la ventana', () => {
    const result = evaluateCandidate(asset('a2', 'lenceria-roja'), {
      at: utc('2026-04-03T00:00:00Z'),
      platform: 'telegram',
      rules: rules({ outfitCooldownDays: 7, minGapMinutes: 0 }),
      history: [published('a1', '2026-04-01T00:00:00Z', 'lenceria-roja')],
    });

    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual(['outfit_cooldown']);
    expect(result.availableAt?.toISOString()).toBe('2026-04-08T00:00:00.000Z');
  });

  it('no bloquea si la prenda es distinta', () => {
    const result = evaluateCandidate(asset('a2', 'vestido-negro'), {
      at: utc('2026-04-03T00:00:00Z'),
      platform: 'telegram',
      rules: rules({ outfitCooldownDays: 7, minGapMinutes: 0 }),
      history: [published('a1', '2026-04-01T00:00:00Z', 'lenceria-roja')],
    });

    expect(result.eligible).toBe(true);
  });

  it('deja pasar los assets sin prenda etiquetada', () => {
    // Material antiguo ingerido sin clasificar: bloquearlo por defecto dejaria
    // el vault entero congelado, que es justo lo contrario del reciclador.
    const result = evaluateCandidate(asset('a2', null), {
      at: utc('2026-04-03T00:00:00Z'),
      platform: 'telegram',
      rules: rules({ outfitCooldownDays: 7, minGapMinutes: 0 }),
      history: [published('a1', '2026-04-01T00:00:00Z', null)],
    });

    expect(result.eligible).toBe(true);
  });

  it('no se penaliza a si mismo por su propia publicacion anterior', () => {
    // Su historial ya lo controla el enfriamiento del asset; contarlo tambien
    // como prenda duplicaria la penalizacion y correria la fecha de liberacion.
    const result = evaluateCandidate(asset('a1', 'lenceria-roja'), {
      at: utc('2026-04-20T00:00:00Z'),
      platform: 'telegram',
      rules: rules({ assetCooldownDays: 10, outfitCooldownDays: 30, minGapMinutes: 0 }),
      history: [published('a1', '2026-04-01T00:00:00Z', 'lenceria-roja')],
    });

    expect(result.eligible).toBe(true);
    expect(result.reasons).not.toContain('outfit_cooldown');
  });

  it('libera la prenda exactamente al cumplirse el plazo', () => {
    const result = evaluateCandidate(asset('a2', 'lenceria-roja'), {
      at: utc('2026-04-08T00:00:00Z'),
      platform: 'telegram',
      rules: rules({ outfitCooldownDays: 7, minGapMinutes: 0 }),
      history: [published('a1', '2026-04-01T00:00:00Z', 'lenceria-roja')],
    });

    expect(result.eligible).toBe(true);
  });
});

describe('separacion minima', () => {
  it('bloquea una publicacion demasiado pegada a la anterior', () => {
    const result = evaluateCandidate(asset('a2'), {
      at: utc('2026-04-01T13:00:00Z'),
      platform: 'telegram',
      rules: rules({ minGapMinutes: 120 }),
      history: [published('a1', '2026-04-01T12:00:00Z')],
    });

    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('min_gap');
    expect(result.availableAt?.toISOString()).toBe('2026-04-01T14:00:00.000Z');
  });

  it('tambien mira hacia adelante, no solo hacia atras', () => {
    // Colar algo justo ANTES de lo ya programado deja el mismo hueco corto.
    const result = evaluateCandidate(asset('a2'), {
      at: utc('2026-04-01T11:00:00Z'),
      platform: 'telegram',
      rules: rules({ minGapMinutes: 120 }),
      history: [published('a1', '2026-04-01T12:00:00Z')],
    });

    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('min_gap');
  });

  it('acepta la separacion exacta', () => {
    const result = evaluateCandidate(asset('a2'), {
      at: utc('2026-04-01T14:00:00Z'),
      platform: 'telegram',
      rules: rules({ minGapMinutes: 120 }),
      history: [published('a1', '2026-04-01T12:00:00Z')],
    });

    expect(result.eligible).toBe(true);
  });

  it('no mira publicaciones de otra plataforma', () => {
    const result = evaluateCandidate(asset('a2'), {
      at: utc('2026-04-01T12:30:00Z'),
      platform: 'telegram',
      rules: rules({ minGapMinutes: 120 }),
      history: [published('a1', '2026-04-01T12:00:00Z', null, 'x')],
    });

    expect(result.eligible).toBe(true);
  });

  it('con separacion 0 la regla no aplica', () => {
    const result = evaluateCandidate(asset('a2'), {
      at: utc('2026-04-01T12:00:00Z'),
      platform: 'telegram',
      rules: rules({ minGapMinutes: 0 }),
      history: [published('a1', '2026-04-01T12:00:00Z')],
    });

    expect(result.eligible).toBe(true);
  });
});

describe('tope diario', () => {
  const sixPosts = Array.from({ length: 6 }, (_, i) =>
    published(`x${i}`, `2026-04-01T${String(i + 1).padStart(2, '0')}:00:00Z`),
  );

  it('bloquea al alcanzar el tope', () => {
    const result = evaluateCandidate(asset('a9'), {
      at: utc('2026-04-01T23:00:00Z'),
      platform: 'telegram',
      rules: rules({ maxPostsPerDay: 6, minGapMinutes: 0 }),
      history: sixPosts,
    });

    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('daily_cap');
    // Se libera al empezar el dia UTC siguiente.
    expect(result.availableAt?.toISOString()).toBe('2026-04-02T00:00:00.000Z');
  });

  it('acepta mientras quede un hueco', () => {
    const result = evaluateCandidate(asset('a9'), {
      at: utc('2026-04-01T23:00:00Z'),
      platform: 'telegram',
      rules: rules({ maxPostsPerDay: 7, minGapMinutes: 0 }),
      history: sixPosts,
    });

    expect(result.eligible).toBe(true);
  });

  it('cuenta por dia natural UTC, no por ventana de 24 horas', () => {
    // Seis publicaciones el 1 de abril no consumen la cuota del 2 de abril,
    // aunque la ultima fuera hace apenas una hora.
    const result = evaluateCandidate(asset('a9'), {
      at: utc('2026-04-02T00:30:00Z'),
      platform: 'telegram',
      rules: rules({ maxPostsPerDay: 6, minGapMinutes: 0 }),
      history: [...sixPosts, published('x6', '2026-04-01T23:45:00Z')],
    });

    expect(result.eligible).toBe(true);
  });

  it('cuenta solo la plataforma evaluada', () => {
    const otherPlatform = sixPosts.map((p) => ({ ...p, platform: 'x' as const }));
    const result = evaluateCandidate(asset('a9'), {
      at: utc('2026-04-01T23:00:00Z'),
      platform: 'telegram',
      rules: rules({ maxPostsPerDay: 6, minGapMinutes: 0 }),
      history: otherPlatform,
    });

    expect(result.eligible).toBe(true);
  });

  it('startOfUtcDay corta a medianoche UTC', () => {
    expect(startOfUtcDay(utc('2026-04-01T23:59:59Z')).toISOString()).toBe(
      '2026-04-01T00:00:00.000Z',
    );
  });
});

describe('varias reglas incumplidas a la vez', () => {
  it('reporta todas las razones y la fecha de liberacion mas lejana', () => {
    const result = evaluateCandidate(asset('a1', 'lenceria-roja'), {
      at: utc('2026-04-02T12:30:00Z'),
      platform: 'telegram',
      rules: rules({ assetCooldownDays: 30, outfitCooldownDays: 7, minGapMinutes: 120 }),
      history: [
        published('a1', '2026-04-01T12:00:00Z', 'lenceria-roja'),
        published('a2', '2026-04-02T12:00:00Z', 'vestido-negro'),
      ],
    });

    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual(['asset_cooldown', 'min_gap']);
    // El enfriamiento del asset (1 mayo) manda sobre la separacion minima.
    expect(result.availableAt?.toISOString()).toBe('2026-05-01T12:00:00.000Z');
  });
});

describe('seleccion del siguiente asset', () => {
  const ctx = (history: PublicationRecord[] = []) => ({
    at: utc('2026-06-01T12:00:00Z'),
    platform: 'telegram' as const,
    rules: rules({ minGapMinutes: 0 }),
    history,
  });

  it('prefiere el que nunca se ha publicado', () => {
    const choice = selectNextAsset(
      [asset('usado'), asset('nuevo')],
      ctx([published('usado', '2026-01-01T00:00:00Z')]),
    );

    expect(choice?.asset.id).toBe('nuevo');
  });

  it('entre nunca publicados saca primero el mas antiguo del vault', () => {
    const choice = selectNextAsset(
      [
        asset('reciente', null, utc('2026-05-01T00:00:00Z')),
        asset('viejo', null, utc('2024-02-01T00:00:00Z')),
      ],
      ctx(),
    );

    expect(choice?.asset.id).toBe('viejo');
  });

  it('entre publicados saca el que lleva mas tiempo sin salir', () => {
    const choice = selectNextAsset(
      [asset('a1'), asset('a2')],
      ctx([
        published('a1', '2026-01-10T00:00:00Z'),
        published('a2', '2026-01-02T00:00:00Z'),
      ]),
    );

    expect(choice?.asset.id).toBe('a2');
  });

  it('desempata de forma determinista por id', () => {
    const created = utc('2026-01-01T00:00:00Z');
    const first = selectNextAsset([asset('b'), asset('a'), asset('c')], ctx());
    const second = selectNextAsset([asset('c'), asset('b'), asset('a')], ctx());

    expect(first?.asset.id).toBe('a');
    // El mismo conjunto en otro orden da el mismo resultado.
    expect(second?.asset.id).toBe('a');
    expect(created).toBeInstanceOf(Date);
  });

  it('descarta el mas antiguo si esta bloqueado y toma el siguiente', () => {
    const choice = selectNextAsset(
      [asset('viejo-bloqueado'), asset('nuevo-libre', null, utc('2026-05-01T00:00:00Z'))],
      {
        at: utc('2026-06-01T12:00:00Z'),
        platform: 'telegram',
        rules: rules({ assetCooldownDays: 30, minGapMinutes: 0 }),
        history: [published('viejo-bloqueado', '2026-05-20T00:00:00Z')],
      },
    );

    expect(choice?.asset.id).toBe('nuevo-libre');
  });

  it('devuelve null cuando ningun candidato es elegible', () => {
    const choice = selectNextAsset([asset('a1')], {
      at: utc('2026-06-01T12:00:00Z'),
      platform: 'telegram',
      rules: rules({ assetCooldownDays: 30 }),
      history: [published('a1', '2026-05-30T00:00:00Z')],
    });

    expect(choice).toBeNull();
  });

  it('devuelve null con la lista vacia', () => {
    expect(selectNextAsset([], ctx())).toBeNull();
  });
});

describe('planificacion de una cola completa', () => {
  it('nunca repite la misma prenda dentro del plan', () => {
    // Cuatro assets, dos prendas. Con enfriamiento de prenda de 7 dias y huecos
    // de una hora, solo caben dos publicaciones: una por prenda.
    const plan = planQueue(
      [
        asset('r1', 'roja'),
        asset('r2', 'roja'),
        asset('n1', 'negra'),
        asset('n2', 'negra'),
      ],
      {
        from: utc('2026-04-01T10:00:00Z'),
        platform: 'telegram',
        rules: rules({ outfitCooldownDays: 7, minGapMinutes: 60, maxPostsPerDay: 10 }),
        history: [],
        slots: 4,
        stepMinutes: 60,
        maxEmptySteps: 12,
      },
    );

    expect(plan).toHaveLength(2);
    const prendas = plan.map((p) => p.asset.outfitTag);
    expect(new Set(prendas).size).toBe(2);
  });

  it('separa los huecos segun el paso indicado', () => {
    const plan = planQueue([asset('a1'), asset('a2'), asset('a3')], {
      from: utc('2026-04-01T10:00:00Z'),
      platform: 'telegram',
      rules: rules({ minGapMinutes: 60, maxPostsPerDay: 10 }),
      history: [],
      slots: 3,
      stepMinutes: 90,
    });

    expect(plan.map((p) => p.scheduledAt.toISOString())).toEqual([
      '2026-04-01T10:00:00.000Z',
      '2026-04-01T11:30:00.000Z',
      '2026-04-01T13:00:00.000Z',
    ]);
  });

  it('no usa dos veces el mismo asset', () => {
    const plan = planQueue([asset('a1'), asset('a2')], {
      from: utc('2026-04-01T10:00:00Z'),
      platform: 'telegram',
      rules: rules({ minGapMinutes: 60, maxPostsPerDay: 10 }),
      history: [],
      slots: 5,
      stepMinutes: 60,
      maxEmptySteps: 5,
    });

    expect(plan).toHaveLength(2);
    expect(new Set(plan.map((p) => p.asset.id)).size).toBe(2);
  });

  it('empuja al dia siguiente cuando se agota el tope diario', () => {
    const plan = planQueue(
      [asset('a1'), asset('a2'), asset('a3'), asset('a4')],
      {
        from: utc('2026-04-01T00:00:00Z'),
        platform: 'telegram',
        rules: rules({ minGapMinutes: 60, maxPostsPerDay: 2, outfitCooldownDays: 0 }),
        history: [],
        slots: 4,
        stepMinutes: 60,
      },
    );

    expect(plan).toHaveLength(4);
    expect(plan.map((p) => p.scheduledAt.toISOString())).toEqual([
      '2026-04-01T00:00:00.000Z',
      '2026-04-01T01:00:00.000Z',
      '2026-04-02T00:00:00.000Z',
      '2026-04-02T01:00:00.000Z',
    ]);
  });

  it('se rinde de forma acotada cuando nada es publicable', () => {
    const plan = planQueue([asset('a1')], {
      from: utc('2026-04-01T00:00:00Z'),
      platform: 'telegram',
      rules: rules({ assetCooldownDays: 365, minGapMinutes: 60 }),
      history: [published('a1', '2026-03-31T00:00:00Z')],
      slots: 3,
      stepMinutes: 60,
      maxEmptySteps: 5,
    });

    expect(plan).toEqual([]);
  });

  it('el historial previo condiciona el plan nuevo', () => {
    const plan = planQueue([asset('a1', 'roja'), asset('a2', 'negra')], {
      from: utc('2026-04-01T10:00:00Z'),
      platform: 'telegram',
      rules: rules({ outfitCooldownDays: 7, minGapMinutes: 60, maxPostsPerDay: 10 }),
      history: [published('viejo', '2026-03-30T10:00:00Z', 'roja')],
      slots: 2,
      stepMinutes: 60,
      maxEmptySteps: 4,
    });

    // 'roja' salio hace dos dias: solo entra 'negra'.
    expect(plan).toHaveLength(1);
    expect(plan[0]?.asset.id).toBe('a2');
    expect(MINUTE).toBe(60_000);
  });
});
