import { safeStorage } from 'electron'
import * as fs from 'fs'
import { CREDENTIALS_FILE, readJson, writeJsonAtomic } from './paths'

// Credentials are encrypted with Electron safeStorage (macOS Keychain-backed)
// and stored as base64 blobs. Teammates onboard by pasting their own keys.

interface CredentialFile {
  linearApiKey?: string // base64 of encrypted buffer
  ghToken?: string
  figmaToken?: string
  posthogApiKey?: string
  plaintext?: boolean // fallback when safeStorage is unavailable
}

type Credentials = {
  linearApiKey?: string
  ghToken?: string
  figmaToken?: string
  posthogApiKey?: string
}

let cache: Credentials | null = null

function load(): Credentials {
  if (cache) return cache
  const file = readJson<CredentialFile>(CREDENTIALS_FILE, {})
  const decode = (v?: string): string | undefined => {
    if (!v) return undefined
    try {
      if (file.plaintext) return Buffer.from(v, 'base64').toString('utf8')
      return safeStorage.decryptString(Buffer.from(v, 'base64'))
    } catch {
      return undefined
    }
  }
  cache = {
    linearApiKey: decode(file.linearApiKey),
    ghToken: decode(file.ghToken),
    figmaToken: decode(file.figmaToken),
    posthogApiKey: decode(file.posthogApiKey)
  }
  return cache
}

export function getLinearApiKey(): string | undefined {
  return load().linearApiKey || process.env.LINEAR_API_KEY
}

export function getGhToken(): string | undefined {
  return load().ghToken || process.env.GH_TOKEN
}

export function getFigmaToken(): string | undefined {
  return load().figmaToken || process.env.FIGMA_TOKEN
}

export function getPosthogApiKey(): string | undefined {
  return load().posthogApiKey || process.env.POSTHOG_API_KEY
}

export function setCredentials(input: Credentials): void {
  const current = load()
  const next = {
    linearApiKey:
      input.linearApiKey !== undefined ? input.linearApiKey.trim() : current.linearApiKey,
    ghToken: input.ghToken !== undefined ? input.ghToken.trim() : current.ghToken,
    figmaToken: input.figmaToken !== undefined ? input.figmaToken.trim() : current.figmaToken,
    posthogApiKey:
      input.posthogApiKey !== undefined ? input.posthogApiKey.trim() : current.posthogApiKey
  }
  const canEncrypt = safeStorage.isEncryptionAvailable()
  const encode = (v?: string): string | undefined => {
    if (!v) return undefined
    return canEncrypt
      ? safeStorage.encryptString(v).toString('base64')
      : Buffer.from(v, 'utf8').toString('base64')
  }
  const file: CredentialFile = {
    linearApiKey: encode(next.linearApiKey),
    ghToken: encode(next.ghToken),
    figmaToken: encode(next.figmaToken),
    posthogApiKey: encode(next.posthogApiKey),
    plaintext: !canEncrypt
  }
  writeJsonAtomic(CREDENTIALS_FILE, file)
  fs.chmodSync(CREDENTIALS_FILE, 0o600)
  cache = next
}
