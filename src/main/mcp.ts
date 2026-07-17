import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// Claude Code stores user-scope MCP servers in ~/.claude.json under
// `mcpServers`. Servers connected through claude.ai (connectors) live
// server-side and never appear in this file, so they can be loaded via
// "all" but not included in a per-phase subset.
const CLAUDE_CONFIG = path.join(os.homedir(), '.claude.json')

function readGlobalMcpServers(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(CLAUDE_CONFIG, 'utf8')) as {
      mcpServers?: Record<string, unknown>
    }
    return parsed.mcpServers ?? {}
  } catch {
    return {}
  }
}

/** Server names offered by the per-phase MCP picker in settings. */
export function listGlobalMcpServerNames(): string[] {
  return Object.keys(readGlobalMcpServers()).sort()
}

/**
 * Write a `--mcp-config` file holding only the selected servers' configs and
 * return its path, resolved at spawn time so it tracks the user's current
 * ~/.claude.json. Undefined when no selected name exists there (the session
 * then runs with --strict-mcp-config alone, i.e. no servers).
 *
 * A file, not inline JSON: server configs can carry auth headers, and argv is
 * world-readable (ps) and persisted on the session record for UI display.
 */
export function subsetMcpConfigFile(names: string[]): string | undefined {
  const all = readGlobalMcpServers()
  const picked: Record<string, unknown> = {}
  for (const name of names) if (name in all) picked[name] = all[name]
  if (Object.keys(picked).length === 0) return undefined
  const json = JSON.stringify({ mcpServers: picked })
  // same subset -> same file; content refreshed every spawn
  const hash = crypto.createHash('sha256').update(json).digest('hex').slice(0, 12)
  const file = path.join(os.tmpdir(), `sully-mcp-${hash}.json`)
  fs.writeFileSync(file, json, { mode: 0o600 })
  return file
}
