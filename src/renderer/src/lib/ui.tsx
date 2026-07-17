import type { ReactElement, ReactNode } from 'react'
import { cn } from './utils'

export function Vu(): ReactElement {
  return (
    <span className="vu inline-flex h-3 items-end gap-[2px]" aria-label="running">
      <span style={{ height: 12 }} />
      <span style={{ height: 12 }} />
      <span style={{ height: 12 }} />
      <span style={{ height: 12 }} />
    </span>
  )
}

export function Toggle({
  checked,
  onChange,
  label
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label?: string
}): ReactElement {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-[20px] w-[36px] rounded-full transition-colors duration-200',
        checked ? 'bg-brass-500' : 'bg-ink-600'
      )}
    >
      <span
        className={cn(
          // left-0 matters: without it the knob's static position is the
          // button's centered content box and the translate overshoots
          'absolute left-0 top-[2px] h-[16px] w-[16px] rounded-full bg-ink-50 shadow transition-transform duration-200',
          checked ? 'translate-x-[18px]' : 'translate-x-[2px]'
        )}
      />
    </button>
  )
}

export function Button({
  children,
  onClick,
  variant = 'ghost',
  disabled,
  className,
  title
}: {
  children: ReactNode
  onClick?: () => void
  variant?: 'primary' | 'ghost' | 'danger'
  disabled?: boolean
  className?: string
  title?: string
}): ReactElement {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 text-[12px] font-bold transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-40',
        variant === 'primary' && 'bg-brass-500 text-ink-950 hover:bg-brass-400 active:scale-[0.98]',
        variant === 'ghost' &&
          'hairline-strong border border-solid text-ink-200 hover:bg-ink-700 hover:text-ink-50',
        variant === 'danger' && 'text-terra-400 hover:bg-terra-500/10',
        className
      )}
    >
      {children}
    </button>
  )
}

export function EmptyState({ title, hint }: { title: string; hint?: string }): ReactElement {
  return (
    <div className="fade-up flex h-full min-h-[200px] flex-col items-center justify-center gap-2 py-16 text-center">
      <p className="font-display text-[22px] text-ink-300">{title}</p>
      {hint && <p className="max-w-[420px] text-[12.5px] text-ink-400">{hint}</p>}
    </div>
  )
}

export function SectionTitle({ children }: { children: ReactNode }): ReactElement {
  return (
    <h2 className="mb-3 font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-ink-400">
      {children}
    </h2>
  )
}
