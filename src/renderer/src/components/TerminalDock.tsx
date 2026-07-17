import type { ReactElement, ReactNode } from 'react'
import Dock from './Dock'
import AgentTerminal from './AgentTerminal'

/**
 * Dockable agent-terminal region for dialogs. One shared layout key: the
 * preferred terminal placement follows the user across every dialog that
 * embeds an agent terminal (deliberately not in AppSettings — writing
 * settings kicks an orchestrator poll).
 */
export default function TerminalDock({
  issueId,
  open,
  children
}: {
  issueId: string
  open: boolean
  children: ReactNode
}): ReactElement {
  return (
    <Dock
      open={open}
      label="agent terminal"
      storageKey="sully:term-dock"
      fallback={{ side: 'bottom', width: 480, height: 280 }}
      pane={<AgentTerminal issueId={issueId} />}
    >
      {children}
    </Dock>
  )
}
