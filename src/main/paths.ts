import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'

// All persistent state lives under ~/.claude/sully — greppable, debuggable,
// survives app reinstalls, and mirrors the existing ~/.claude/* convention.
const LEGACY_CONFIG_DIR = path.join(os.homedir(), '.claude', 'conductor')
export const CONFIG_DIR = path.join(os.homedir(), '.claude', 'sully')
export const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json')
export const STATE_FILE = path.join(CONFIG_DIR, 'state.json')
export const REVIEWS_FILE = path.join(CONFIG_DIR, 'pr-reviews.json')
// url -> head SHA of the last launched review; outlives REVIEWS_FILE row
// retention so an unchanged PR is never re-reviewed at full cost
export const REVIEW_ATTEMPTS_FILE = path.join(CONFIG_DIR, 'pr-review-attempts.json')
export const CREDENTIALS_FILE = path.join(CONFIG_DIR, 'credentials.json')
export const SESSIONS_DIR = path.join(CONFIG_DIR, 'sessions')
export const LOGS_DIR = path.join(CONFIG_DIR, 'logs')

export function ensureDirs(): void {
  migrateLegacyDir()
  for (const d of [CONFIG_DIR, SESSIONS_DIR, LOGS_DIR]) fs.mkdirSync(d, { recursive: true })
}

// Run at import time, NOT just from app.whenReady(): the settings/state stores
// are module-level singletons that read their files as soon as they're
// imported. Migration and dir creation must be complete before that, or a
// store loads defaults and later clobbers the real file (happened once during
// the conductor→sully rename).
ensureDirs()

/** One-time move of ~/.claude/conductor -> ~/.claude/sully (app rename). */
function migrateLegacyDir(): void {
  if (!fs.existsSync(LEGACY_CONFIG_DIR) || fs.existsSync(CONFIG_DIR)) return
  fs.renameSync(LEGACY_CONFIG_DIR, CONFIG_DIR)
  // session records store absolute log paths under the old dir — rewrite them
  const sessionsDir = path.join(CONFIG_DIR, 'sessions')
  let files: string[] = []
  try {
    files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json'))
  } catch {
    return
  }
  for (const f of files) {
    const p = path.join(sessionsDir, f)
    try {
      fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replaceAll(LEGACY_CONFIG_DIR, CONFIG_DIR))
    } catch {
      // best effort
    }
  }
}

/** Atomic JSON write (tmp + rename) so readers never see partial files. */
export function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
  fs.renameSync(tmp, file)
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}
