import { useState, type ReactElement } from 'react'
import { KeyRound, GitBranch, ArrowRight, CheckCircle2, XCircle } from 'lucide-react'
import { useApp } from '../store'
import { Button } from '../lib/ui'
import { cn } from '../lib/utils'

export default function OnboardingView(): ReactElement {
  const { credentials, settings, refresh, applySettings } = useApp()
  const [linearKey, setLinearKey] = useState('')
  const [ghToken, setGhToken] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const linearOk = credentials?.linearKeySet
  const ghOk = credentials?.ghCliAuthed || credentials?.ghTokenSet

  async function saveKeys(): Promise<void> {
    setSaving(true)
    setError(null)
    try {
      await window.sully.setCredentials({
        ...(linearKey.trim() ? { linearApiKey: linearKey.trim() } : {}),
        ...(ghToken.trim() ? { ghToken: ghToken.trim() } : {})
      })
      await refresh()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function finish(): Promise<void> {
    if (!settings) return
    const next = { ...settings, onboarded: true }
    await window.sully.setSettings(next)
    applySettings(next)
  }

  return (
    <div className="atmosphere flex h-full flex-col">
      <div className="titlebar-drag h-[52px] shrink-0" />
      <div className="flex flex-1 items-center justify-center overflow-y-auto px-8">
        <div className="fade-up w-full max-w-[460px] pb-16">
          <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-brass-400">
            welcome to
          </p>
          <h1 className="mt-1 font-display text-[44px] leading-tight text-ink-50">Sully</h1>
          <p className="mt-3 text-[14px] leading-relaxed text-ink-300">
            Your Linear board becomes the baton: tickets get planned, coded, and reviewed by
            headless AI sessions — you approve at every gate.
          </p>

          <div className="hairline mt-8 space-y-4 rounded-2xl border bg-ink-900/80 p-5">
            <div>
              <label className="flex items-center gap-2 text-[12.5px] font-bold text-ink-100">
                <KeyRound size={14} className="text-brass-400" />
                Linear API key
                {linearOk ? (
                  <CheckCircle2 size={14} className="ml-auto text-sage-400" />
                ) : (
                  <XCircle size={14} className="ml-auto text-ink-400" />
                )}
              </label>
              <input
                type="password"
                value={linearKey}
                onChange={(e) => setLinearKey(e.target.value)}
                placeholder={linearOk ? '•••••••• (saved)' : 'lin_api_…'}
                className="hairline-strong selectable mt-2 w-full rounded-lg border bg-ink-950 px-3 py-2 font-mono text-[12px] text-ink-50 placeholder:text-ink-400 focus:border-brass-500 focus:outline-none"
              />
              <p className="mt-1.5 text-[11px] text-ink-400">
                Personal key from{' '}
                <button
                  className="text-brass-300 underline"
                  onClick={() =>
                    void window.sully.openExternal('https://linear.app/settings/account/security')
                  }
                >
                  linear.app/settings/account/security
                </button>
                . Stored encrypted in your macOS Keychain.
              </p>
            </div>

            <div className="hairline border-t pt-4">
              <label className="flex items-center gap-2 text-[12.5px] font-bold text-ink-100">
                <GitBranch size={14} className="text-brass-400" />
                GitHub
                {ghOk ? (
                  <CheckCircle2 size={14} className="ml-auto text-sage-400" />
                ) : (
                  <XCircle size={14} className="ml-auto text-ink-400" />
                )}
              </label>
              {credentials?.ghCliAuthed ? (
                <p className="mt-1.5 text-[11.5px] text-ink-300">
                  gh CLI is already authenticated — nothing to do.
                </p>
              ) : (
                <>
                  <input
                    type="password"
                    value={ghToken}
                    onChange={(e) => setGhToken(e.target.value)}
                    placeholder="ghp_… (or run `gh auth login` in a terminal)"
                    className="hairline-strong selectable mt-2 w-full rounded-lg border bg-ink-950 px-3 py-2 font-mono text-[12px] text-ink-50 placeholder:text-ink-400 focus:border-brass-500 focus:outline-none"
                  />
                  <p className="mt-1.5 text-[11px] text-ink-400">
                    Easiest path: run <code className="font-mono text-ink-200">gh auth login</code>{' '}
                    once in a terminal, then hit Verify.
                  </p>
                </>
              )}
            </div>

            {error && <p className="text-[12px] text-terra-400">{error}</p>}

            <div className="flex items-center justify-between pt-1">
              <Button onClick={() => void saveKeys()} disabled={saving}>
                {saving ? 'Verifying…' : 'Save & verify'}
              </Button>
              <Button
                variant="primary"
                onClick={() => void finish()}
                disabled={!linearOk || !ghOk}
                className={cn(
                  !linearOk || !ghOk ? '' : 'shadow-[0_0_24px_var(--color-brass-glow)]'
                )}
              >
                Enter the studio <ArrowRight size={13} />
              </Button>
            </div>
          </div>

          <p className="mt-4 text-center text-[11px] text-ink-400">
            You&apos;ll map your Linear columns and repos in Settings next.
          </p>
        </div>
      </div>
    </div>
  )
}
