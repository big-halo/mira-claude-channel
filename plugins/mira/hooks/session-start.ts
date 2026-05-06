#!/usr/bin/env bun
// SessionStart hook: surface the current Mira tunnel URL.
// The URL is persisted by cloudflare.ts to ~/.mira-mcp/tunnel.url whenever
// cloudflared finishes publishing a quick tunnel. We poll briefly because
// SessionStart fires before the MCP server (and therefore the tunnel) is up.

const URL_FILE = `${process.env.HOME}/.mira-mcp/tunnel.url`

let url = ''
for (let i = 0; i < 12 && !url; i++) {
  url = (await Bun.file(URL_FILE).text().catch(() => '')).trim()
  if (!url) await Bun.sleep(500)
}

console.log(JSON.stringify(
  url
    ? {
        systemMessage: `Mira tunnel: ${url}`,
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext:
            `The Mira plugin's public tunnel URL for this session is ${url}. ` +
            `Paste it into the Mira iOS app under Settings → Claude Code so the glasses can reach this Claude Code session.`,
        },
      }
    : { systemMessage: `Mira tunnel: starting up… (run /mira:help once it's ready, or check ${URL_FILE})` },
))
