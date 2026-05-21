#!/usr/bin/env bun
// SessionStart hook: inject the Mira agent prompt as additional context.
//
// The same prompt already loads via the agent file, but repeating it in the
// session context noticeably improves adherence — the model treats it as a
// live system instruction rather than just a definition. mira.md stays the
// single source of truth; edit it there and both paths pick up the change.
//
// The tunnel URL is *not* surfaced here. server.ts provisions the tunnel on
// boot and pushes the URL via a channel notification once it's actually
// ready, which is the single source of truth. Reading it from a file here
// was racy and historically served stale values from prior plugin versions.

import { join } from 'path'

const AGENT_FILE = join(import.meta.dir, '..', 'agents', 'mira.md')

const agentPrompt = (await Bun.file(AGENT_FILE).text().catch(() => '')).trim()

console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: agentPrompt,
  },
}))
