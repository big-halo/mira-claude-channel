#!/usr/bin/env bun
// SessionStart hook: surface the current Mira tunnel URL.
//
// We also dump the Mira agent prompt (agents/mira.md) into additionalContext.
// The same prompt already loads via the agent file, but repeating it in the
// session context noticeably improves adherence — the model treats it as a
// live system instruction rather than just a definition. mira.md stays the
// single source of truth; edit it there and both paths pick up the change.

import { join } from 'path'
import { appendFileSync } from 'fs'
import {
  autoUpdatePlugin,
  AUTO_UPDATE_RELOAD_MESSAGE,
  canShowTunnelUrl,
  checkPluginUpdateState,
  TUNNEL_BLOCKED_MESSAGE,
} from '../plugin_update'

const AGENT_FILE = join(import.meta.dir, '..', 'agents', 'mira.md')
const LOG_FILE = '/tmp/mira.log'

function log(msg: string) {
  appendFileSync(LOG_FILE, `[session-start] ${new Date().toISOString()} ${msg}\n`)
}

function hasChannelsFlag(): boolean {
  try {
    let pid = process.ppid
    for (let i = 0; i < 8; i++) {
      const proc = Bun.spawnSync(['ps', '-p', String(pid), '-o', 'ppid=,args='])
      const line = new TextDecoder().decode(proc.stdout).trim()
      if (!line) break
      if (line.includes('dangerously-load-development-channels')) return true
      const spaceIdx = line.indexOf(' ')
      if (spaceIdx < 0) break
      const ppid = parseInt(line.slice(0, spaceIdx).trim())
      if (!ppid || ppid === pid || ppid <= 1) break
      pid = ppid
    }
  } catch {}
  return false
}

const channelsActive = hasChannelsFlag()
log(`channels-flag=${channelsActive}`)

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT ?? join(import.meta.dir, '..')
const agentPrompt = (await Bun.file(AGENT_FILE).text().catch(() => '')).trim()

let systemMessage: string
if (!channelsActive) {
  systemMessage = 'Mira will not work — restart Claude with: claude --dangerously-load-development-channels plugin:mira@mira-marketplace'
} else {
  try {
    const state = await checkPluginUpdateState({ pluginRoot: PLUGIN_ROOT })
    if (!canShowTunnelUrl(state)) {
      const updated = autoUpdatePlugin()
      systemMessage = updated.ok ? AUTO_UPDATE_RELOAD_MESSAGE : TUNNEL_BLOCKED_MESSAGE
    } else {
      systemMessage = 'Mira is spinning up — tunnel coming in hot 🫡'
    }
  } catch {
    systemMessage = 'Mira is spinning up — tunnel coming in hot 🫡'
  }
}

console.log(JSON.stringify({
  systemMessage,
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: agentPrompt,
  },
}))
