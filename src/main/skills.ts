import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills')

/**
 * User-invocable skills installed globally at ~/.claude/skills — offered as
 * per-phase overrides for the claude agent (codex has no skill support).
 */
export function listGlobalSkills(): string[] {
  let entries: string[] = []
  try {
    entries = fs.readdirSync(SKILLS_DIR)
  } catch {
    return []
  }
  const out: string[] = []
  for (const name of entries) {
    try {
      const head = fs.readFileSync(path.join(SKILLS_DIR, name, 'SKILL.md'), 'utf8').slice(0, 2000)
      if (/^user_invocable:\s*false/m.test(head)) continue
      out.push(name)
    } catch {
      // not a skill directory
    }
  }
  return out.sort()
}
