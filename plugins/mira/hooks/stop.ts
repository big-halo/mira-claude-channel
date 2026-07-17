#!/usr/bin/env bun

type StopHookInput = {
  session_id?: string
  transcript_path?: string
  last_assistant_message?: string
}

async function backgroundToolUseIds(path?: string): Promise<string[]> {
  if (!path) return []
  try {
    const file = Bun.file(path)
    const tail = await file.slice(Math.max(0, file.size - 512 * 1024)).text()
    const ids = new Set<string>()
    for (const line of tail.split('\n').reverse()) {
      let entry: any
      try { entry = JSON.parse(line) } catch { continue }
      if (entry?.type !== 'user' || typeof entry?.message?.content !== 'string') continue
      if (entry?.origin?.kind !== 'task-notification') break
      const match = entry.message.content.match(/<tool-use-id>([^<]+)<\/tool-use-id>/)
      if (match) ids.add(match[1].trim())
    }
    return [...ids]
  } catch {
    return []
  }
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
  const backgroundToolIds = await backgroundToolUseIds(input.transcript_path)

  const port = process.env.MIRA_PORT ?? '3141'
  const res = await fetch(`http://127.0.0.1:${port}/api/stop`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session_id: input.session_id,
      last_assistant_message: message,
      background_tool_use_ids: backgroundToolIds,
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
