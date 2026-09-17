import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function Card({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        'rounded-xl border border-ink-700 bg-ink-900 p-5 shadow-sm',
        className,
      )}
    >
      {children}
    </section>
  );
}

export function CardTitle({ children }: { children: ReactNode }) {
  return <h2 className="mb-3 text-sm font-medium text-ink-400">{children}</h2>;
}

export function Metric({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'neutral' | 'ok' | 'warn' | 'danger';
}) {
  const toneClass = {
    neutral: 'text-ink-50',
    ok: 'text-ok-500',
    warn: 'text-warn-500',
    danger: 'text-danger-500',
  }[tone];

  return (
    <Card>
      <CardTitle>{label}</CardTitle>
      <p className={cn('text-3xl font-semibold tabular-nums', toneClass)}>{value}</p>
      {hint !== undefined && <p className="mt-1 text-xs text-ink-400">{hint}</p>}
    </Card>
  );
}
