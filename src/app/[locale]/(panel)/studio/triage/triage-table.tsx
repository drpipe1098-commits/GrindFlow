'use client';

import { useMemo, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { FolderTree, Loader2 } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { MAX_BATCH } from '@/lib/connectors/triage';
import { assignItemsToProfile } from './actions';

export interface TriageItem {
  id: string;
  remote_name: string;
  remote_path: string | null;
  remote_size_bytes: number | null;
  matched_folder: string | null;
  skip_reason: string | null;
  discovered_at: string;
}

export interface TriageProfile {
  id: string;
  display_name: string;
  handle: string;
}

function formatSize(bytes: number | null): string {
  if (bytes === null || bytes <= 0) return '—';
  const mb = bytes / 1_048_576;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`;
}

/**
 * Tabla de triaje con asignacion en lote.
 *
 * La seleccion se guarda en un Set y no en una lista: con quinientas filas,
 * comprobar si una esta marcada en cada renderizado sobre una lista es un
 * recorrido completo por fila.
 */
export function TriageTable({
  items,
  profiles,
}: {
  items: TriageItem[];
  profiles: TriageProfile[];
}) {
  const t = useTranslations('triage');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [profileId, setProfileId] = useState('');
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const allSelected = selected.size > 0 && selected.size === items.length;

  // Se agrupa por la carpeta que se intento emparejar: quien hace el triaje casi
  // siempre asigna una carpeta entera a la misma modelo, no archivo por archivo.
  const grouped = useMemo(() => {
    const groups = new Map<string, TriageItem[]>();
    for (const item of items) {
      const key = item.matched_folder ?? t('noFolder');
      const existing = groups.get(key);
      if (existing === undefined) groups.set(key, [item]);
      else existing.push(item);
    }
    return [...groups.entries()];
  }, [items, t]);

  function toggle(id: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleGroup(group: TriageItem[]): void {
    setSelected((current) => {
      const next = new Set(current);
      const everySelected = group.every((item) => next.has(item.id));
      for (const item of group) {
        if (everySelected) next.delete(item.id);
        else next.add(item.id);
      }
      return next;
    });
  }

  function onAssign(): void {
    if (selected.size === 0 || profileId === '') return;

    startTransition(async () => {
      const result = await assignItemsToProfile({
        itemIds: [...selected],
        profileId,
      });

      if (!result.ok) {
        setMessage({ tone: 'error', text: t(`errors.${result.error}`) });
        return;
      }

      setMessage({
        tone: 'ok',
        text: t('assigned', {
          assigned: result.summary.assigned,
          untouched: result.summary.untouched,
        }),
      });
      setSelected(new Set());
    });
  }

  const overBatch = selected.size > MAX_BATCH;

  return (
    <div className="flex flex-col gap-4">
      <Card className="sticky top-0 z-10 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() =>
            setSelected(allSelected ? new Set() : new Set(items.map((item) => item.id)))
          }
          className="rounded-lg border border-ink-700 px-3 py-1.5 text-sm text-ink-200 transition hover:bg-ink-800"
        >
          {allSelected ? t('clearAll') : t('selectAll')}
        </button>

        <span className="text-sm text-ink-400">
          {t('selectedCount', { count: selected.size })}
        </span>

        <select
          value={profileId}
          onChange={(event) => setProfileId(event.target.value)}
          className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-1.5 text-sm text-ink-50"
        >
          <option value="">{t('choose')}</option>
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.display_name} (@{profile.handle})
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={onAssign}
          disabled={pending || selected.size === 0 || profileId === '' || overBatch}
          className="flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-brand-600 disabled:opacity-40"
        >
          {pending && <Loader2 size={14} className="animate-spin" aria-hidden />}
          {t('assign')}
        </button>

        {overBatch && (
          <span className="text-sm text-warn-500">{t('errors.lote_demasiado_grande')}</span>
        )}

        {message !== null && (
          <span
            role="status"
            className={message.tone === 'ok' ? 'text-sm text-ok-500' : 'text-sm text-danger-500'}
          >
            {message.text}
          </span>
        )}
      </Card>

      {grouped.map(([folder, group]) => (
        <Card key={folder}>
          <header className="mb-3 flex items-center gap-2">
            <FolderTree size={16} className="text-ink-400" aria-hidden />
            <button
              type="button"
              onClick={() => toggleGroup(group)}
              className="text-sm font-medium text-ink-50 underline-offset-4 hover:underline"
            >
              {folder}
            </button>
            <span className="text-xs text-ink-400">
              {t('filesInFolder', { count: group.length })}
            </span>
          </header>

          <ul className="flex flex-col divide-y divide-ink-800">
            {group.map((item) => (
              <li key={item.id} className="flex items-center gap-3 py-2">
                <input
                  type="checkbox"
                  checked={selected.has(item.id)}
                  onChange={() => toggle(item.id)}
                  aria-label={item.remote_name}
                  className="size-4 accent-brand-500"
                />
                <span className="min-w-0 flex-1 truncate text-sm text-ink-200">
                  {item.remote_name}
                </span>
                {/* La ruta original es el contexto que permite decidir de quien es. */}
                <span className="hidden min-w-0 flex-1 truncate text-xs text-ink-400 sm:block">
                  {item.remote_path ?? '—'}
                </span>
                <span className="w-20 shrink-0 text-right text-xs tabular-nums text-ink-400">
                  {formatSize(item.remote_size_bytes)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}
