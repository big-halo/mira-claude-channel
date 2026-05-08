#!/usr/bin/env bun
// PostToolUse hook: tell the Mira server a tool call finished. The server
// pushes a `tool_status: { state: "finished", call_id }` SSE event so the
// iOS app can flip the matching live pill from running to finished.

type Input = {
  session_id?: string
  tool_name?: string
  tool_use_id?: string
  tool_input?: Record<string, unknown>
}

const raw = await new Response(Bun.stdin.stream()).text()
let input: Input
try {
  input = JSON.parse(raw) as Input
} catch {
  process.exit(0)
}

if (!input.tool_name) process.exit(0)

const port = process.env.MIRA_PORT ?? '3141'
await fetch(`http://127.0.0.1:${port}/api/tool-status`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    state: 'finished',
    tool_name: input.tool_name,
    tool_use_id: input.tool_use_id,
    tool_input: input.tool_input,
  }),
}).catch(() => null)
