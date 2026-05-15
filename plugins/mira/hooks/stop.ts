#!/usr/bin/env bun

type StopHookInput = {
  session_id?: string
  transcript_path?: string
  stop_hook_active?: boolean
  last_assistant_message?: string
}

async function main() {
  const raw = await new Response(Bun.stdin.stream()).text()
  let input: StopHookInput
  try {
    input = JSON.parse(raw) as StopHookInput
  } catch {
    console.error('Mira Stop hook received invalid JSON')
    return
  }

  const message = input.last_assistant_message ?? ''
  if (!message.trim()) return

  const port = process.env.MIRA_PORT ?? '3141'
  const res = await fetch(`http://127.0.0.1:${port}/api/stop`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session_id: input.session_id,
      transcript_path: input.transcript_path,
      stop_hook_active: input.stop_hook_active,
      last_assistant_message: message,
    }),
  }).catch((err) => {
    console.error(`Mira Stop hook delivery failed: ${(err as Error).message}`)
    return null
  })

  if (res && !res.ok) {
    console.error(`Mira Stop hook delivery returned HTTP ${res.status}`)
  }
}

await main()
