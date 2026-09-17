/**
 * Motor anti-repeticion ("Hard Rule") — Modulo 4.
 *
 * Decide si un asset puede publicarse en un momento dado y elige el siguiente de
 * la cola. Es codigo puro a proposito: no toca la base, no lee el reloj del
 * sistema y no depende de la red. Todo lo que necesita entra por parametro, asi
 * que cada regla se puede probar con fechas fijas y resultados exactos.
 *
 * Las cuatro reglas que aplica:
 *
 *   1. Enfriamiento del asset   — un mismo archivo no se repite antes de X dias.
 *   2. Enfriamiento de la prenda — una misma prenda o sesion no se repite antes
 *      de Y dias, aunque el archivo sea otro. Es la regla que de verdad evita
 *      que el feed se vea repetitivo: publicar diez fotos distintas del mismo
 *      conjunto en una semana se nota igual que repetir una.
 *   3. Separacion minima         — dos publicaciones del mismo perfil en la misma
 *      plataforma no pueden ir pegadas.
 *   4. Tope diario               — maximo de publicaciones por dia natural (UTC).
 *
 * Convenio de limites: un enfriamiento de N dias bloquea mientras
 * `momento < ultimoUso + N dias`. Justo al cumplirse el plazo, el asset vuelve a
 * estar disponible. El limite es inclusivo hacia la disponibilidad.
 *
 * Convenio de dias: el tope diario usa dias naturales UTC, no la zona horaria de
 * la agencia. Es deliberado: una organizacion puede tener modelos en varios
 * husos y el unico corte que no se mueve es el de UTC.
 */

export type Platform = 'telegram' | 'x' | 'reddit' | 'bluesky' | 'webhook';

export interface SchedulingRules {
  /** Dias que debe esperar un asset concreto antes de reutilizarse. */
  assetCooldownDays: number;
  /** Dias que debe esperar una prenda o sesion antes de repetirse. */
  outfitCooldownDays: number;
  /** Minutos minimos entre dos publicaciones del mismo perfil y plataforma. */
  minGapMinutes: number;
  /** Tope de publicaciones por dia natural UTC, por perfil y plataforma. */
  maxPostsPerDay: number;
}

export const DEFAULT_RULES: SchedulingRules = {
  assetCooldownDays: 30,
  outfitCooldownDays: 7,
  minGapMinutes: 120,
  maxPostsPerDay: 6,
};

export interface CandidateAsset {
  id: string;
  outfitTag: string | null;
  /** Momento en que se ingirio. Desempata entre candidatos nunca publicados. */
  createdAt: Date;
}

/** Una publicacion ya programada o ya hecha. Es la memoria del motor. */
export interface PublicationRecord {
  assetId: string;
  outfitTag: string | null;
  platform: Platform;
  scheduledAt: Date;
}

export type RejectionReason =
  | 'asset_cooldown'
  | 'outfit_cooldown'
  | 'min_gap'
  | 'daily_cap';

export interface Evaluation {
  eligible: boolean;
  /** Reglas incumplidas, en orden estable. Vacio si es elegible. */
  reasons: RejectionReason[];
  /**
   * Primer momento en que el asset dejaria de estar bloqueado, considerando
   * todas las reglas incumplidas a la vez. `null` si ya es elegible.
   * El tope diario devuelve el inicio del dia UTC siguiente.
   */
  availableAt: Date | null;
}

export interface EvaluationContext {
  /** Momento propuesto para la publicacion. */
  at: Date;
  platform: Platform;
  rules: SchedulingRules;
  /** Historial del perfil. Puede venir sin ordenar. */
  history: readonly PublicationRecord[];
}

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

const addDays = (date: Date, days: number): Date =>
  new Date(date.getTime() + days * MS_PER_DAY);

const addMinutes = (date: Date, minutes: number): Date =>
  new Date(date.getTime() + minutes * MS_PER_MINUTE);

/** Inicio del dia natural UTC al que pertenece la fecha. */
export const startOfUtcDay = (date: Date): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

const latest = (dates: readonly Date[]): Date | null =>
  dates.reduce<Date | null>(
    (max, d) => (max === null || d.getTime() > max.getTime() ? d : max),
    null,
  );

/**
 * Evalua un candidato contra las cuatro reglas.
 *
 * Nunca corta al primer incumplimiento: devuelve TODAS las razones. Un panel que
 * dice "bloqueado por enfriamiento de prenda" cuando ademas se supero el tope
 * diario manda a la persona a resolver media causa y a chocar otra vez.
 */
export function evaluateCandidate(
  asset: CandidateAsset,
  context: EvaluationContext,
): Evaluation {
  const { at, platform, rules, history } = context;
  const reasons: RejectionReason[] = [];
  const blockers: Date[] = [];

  const samePlatform = history.filter((h) => h.platform === platform);

  // --- 1. Enfriamiento del asset (cuenta en todas las plataformas) -----------
  // Reutilizar la misma foto en X y en Telegram el mismo dia es repetirla: el
  // publico se solapa. Por eso esta regla mira el historial completo.
  const assetLastUse = latest(
    history.filter((h) => h.assetId === asset.id).map((h) => h.scheduledAt),
  );
  if (assetLastUse !== null) {
    const freeAt = addDays(assetLastUse, rules.assetCooldownDays);
    if (at.getTime() < freeAt.getTime()) {
      reasons.push('asset_cooldown');
      blockers.push(freeAt);
    }
  }

  // --- 2. Enfriamiento de la prenda -----------------------------------------
  // Un asset sin prenda etiquetada queda exento: no se puede razonar sobre una
  // etiqueta que no existe, y bloquear por defecto paralizaria el material
  // antiguo que se ingirio sin clasificar.
  if (asset.outfitTag !== null) {
    const outfitLastUse = latest(
      history
        .filter((h) => h.outfitTag === asset.outfitTag && h.assetId !== asset.id)
        .map((h) => h.scheduledAt),
    );
    if (outfitLastUse !== null) {
      const freeAt = addDays(outfitLastUse, rules.outfitCooldownDays);
      if (at.getTime() < freeAt.getTime()) {
        reasons.push('outfit_cooldown');
        blockers.push(freeAt);
      }
    }
  }

  // --- 3. Separacion minima entre publicaciones ------------------------------
  // Mira a ambos lados: colar una publicacion justo antes de otra ya programada
  // deja el mismo hueco insuficiente que colarla justo despues.
  if (rules.minGapMinutes > 0) {
    const gapMs = rules.minGapMinutes * MS_PER_MINUTE;
    const conflicts = samePlatform.filter(
      (h) => Math.abs(h.scheduledAt.getTime() - at.getTime()) < gapMs,
    );
    if (conflicts.length > 0) {
      reasons.push('min_gap');
      const lastConflict = latest(conflicts.map((h) => h.scheduledAt));
      if (lastConflict !== null) {
        blockers.push(addMinutes(lastConflict, rules.minGapMinutes));
      }
    }
  }

  // --- 4. Tope diario --------------------------------------------------------
  const dayStart = startOfUtcDay(at);
  const dayEnd = addDays(dayStart, 1);
  const sameDay = samePlatform.filter(
    (h) =>
      h.scheduledAt.getTime() >= dayStart.getTime() &&
      h.scheduledAt.getTime() < dayEnd.getTime(),
  );
  if (sameDay.length >= rules.maxPostsPerDay) {
    reasons.push('daily_cap');
    blockers.push(dayEnd);
  }

  if (reasons.length === 0) {
    return { eligible: true, reasons: [], availableAt: null };
  }

  return { eligible: false, reasons, availableAt: latest(blockers) };
}

export interface Selection {
  asset: CandidateAsset;
  evaluation: Evaluation;
}

/**
 * Elige el mejor candidato elegible para un momento dado.
 *
 * Criterio de orden, y el porque de cada nivel:
 *   1. El que lleva mas tiempo sin publicarse. Los nunca publicados van primero:
 *      material recien ingerido que nadie ha visto vale mas que una repeticion.
 *   2. A igualdad, el mas antiguo por fecha de ingesta: saca del vault lo que
 *      lleva mas tiempo parado, que es justamente para lo que existe el reciclador.
 *   3. A igualdad, el id menor. No aporta nada al negocio, pero hace la funcion
 *      determinista: la misma entrada da siempre la misma salida, y eso es lo
 *      que permite probarla.
 */
export function selectNextAsset(
  candidates: readonly CandidateAsset[],
  context: EvaluationContext,
): Selection | null {
  const lastUseByAsset = new Map<string, number>();
  for (const record of context.history) {
    const current = lastUseByAsset.get(record.assetId);
    const time = record.scheduledAt.getTime();
    if (current === undefined || time > current) {
      lastUseByAsset.set(record.assetId, time);
    }
  }

  const eligible = candidates
    .map((asset) => ({ asset, evaluation: evaluateCandidate(asset, context) }))
    .filter((entry) => entry.evaluation.eligible);

  if (eligible.length === 0) {
    return null;
  }

  eligible.sort((a, b) => {
    const aLast = lastUseByAsset.get(a.asset.id) ?? Number.NEGATIVE_INFINITY;
    const bLast = lastUseByAsset.get(b.asset.id) ?? Number.NEGATIVE_INFINITY;
    if (aLast !== bLast) return aLast - bLast;

    const created = a.asset.createdAt.getTime() - b.asset.createdAt.getTime();
    if (created !== 0) return created;

    return a.asset.id < b.asset.id ? -1 : a.asset.id > b.asset.id ? 1 : 0;
  });

  return eligible[0] ?? null;
}

export interface PlanOptions {
  /** Primer hueco a evaluar. */
  from: Date;
  platform: Platform;
  rules: SchedulingRules;
  history: readonly PublicationRecord[];
  /** Cuantas publicaciones se quieren colocar. */
  slots: number;
  /** Separacion entre huecos consecutivos. Por defecto, la separacion minima. */
  stepMinutes?: number;
  /**
   * Cuantos huecos vacios seguidos se toleran antes de rendirse. Evita que un
   * catalogo pequeno y muy enfriado haga girar el bucle indefinidamente.
   */
  maxEmptySteps?: number;
}

export interface PlannedPost {
  asset: CandidateAsset;
  scheduledAt: Date;
}

/**
 * Construye una secuencia de publicaciones respetando las cuatro reglas.
 *
 * Cada elemento que coloca entra en el historial simulado, de modo que el
 * siguiente se evalua contra un mundo que ya incluye al anterior. Sin eso, un
 * plan de diez publicaciones podria elegir diez veces la misma prenda: todas
 * validas por separado, imposibles juntas.
 */
export function planQueue(
  candidates: readonly CandidateAsset[],
  options: PlanOptions,
): PlannedPost[] {
  const step = options.stepMinutes ?? options.rules.minGapMinutes;
  const maxEmpty = options.maxEmptySteps ?? 60;

  const simulated: PublicationRecord[] = [...options.history];
  const plan: PlannedPost[] = [];
  const used = new Set<string>();

  let cursor = options.from;
  let emptySteps = 0;

  while (plan.length < options.slots && emptySteps < maxEmpty) {
    const remaining = candidates.filter((c) => !used.has(c.id));
    const choice = selectNextAsset(remaining, {
      at: cursor,
      platform: options.platform,
      rules: options.rules,
      history: simulated,
    });

    if (choice === null) {
      emptySteps += 1;
      cursor = addMinutes(cursor, Math.max(step, 1));
      continue;
    }

    emptySteps = 0;
    plan.push({ asset: choice.asset, scheduledAt: cursor });
    used.add(choice.asset.id);
    simulated.push({
      assetId: choice.asset.id,
      outfitTag: choice.asset.outfitTag,
      platform: options.platform,
      scheduledAt: cursor,
    });
    cursor = addMinutes(cursor, Math.max(step, 1));
  }

  return plan;
}
