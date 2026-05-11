#!/usr/bin/env bun
// SessionStart hook: surface the current Mira tunnel URL.
//
// We also dump the Mira agent prompt (agents/mira.md) into additionalContext.
// The same prompt already loads via the agent file, but repeating it in the
// session context noticeably improves adherence — the model treats it as a
// live system instruction rather than just a definition. mira.md stays the
// single source of truth; edit it there and both paths pick up the change.

import { join } from 'path'

const URL_FILE = `${process.env.HOME}/.mira-mcp/tunnel.url`
const AGENT_FILE = join(import.meta.dir, '..', 'agents', 'mira.md')

let url = ''
for (let i = 0; i < 12 && !url; i++) {
  url = (await Bun.file(URL_FILE).text().catch(() => '')).trim()
  if (!url) await Bun.sleep(500)
}

const agentPrompt = (await Bun.file(AGENT_FILE).text().catch(() => '')).trim()

console.log(JSON.stringify({
  systemMessage: url ? `\nMira Tunnel URL (paste in Mira app to Integrations > Claude Code):\n ${url}` : `Mira tunnel: still starting up…`,
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: agentPrompt,
  },
}))
