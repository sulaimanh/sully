import clsx from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...args: Parameters<typeof clsx>): string {
  return twMerge(clsx(...args))
}

export function timeAgo(iso: string): string {
  const sec = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (sec < 60) return `${Math.floor(sec)}s ago`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`
  return `${Math.floor(sec / 86400)}d ago`
}

export function elapsed(startIso: string, endIso?: string): string {
  const end = endIso ? new Date(endIso).getTime() : Date.now()
  const sec = Math.max(0, (end - new Date(startIso).getTime()) / 1000)
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

export const statusColor: Record<string, string> = {
  running: 'text-brass-400',
  queued: 'text-ink-300',
  done: 'text-sage-400',
  error: 'text-terra-400',
  stopped: 'text-ink-300',
  timeout: 'text-terra-400',
  orphaned: 'text-mist-400',
  reviewing: 'text-brass-400'
}
