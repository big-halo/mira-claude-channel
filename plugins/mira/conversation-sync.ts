import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

type BackendSession = {
  id: string
  title?: string | null
  summary?: string | null
  summary_generated?: boolean
  start_time?: string | null
  end_time?: string | null
  share_token?: string | null
}

type BackendMessage = {
  id: string
  text: string
  speaker: number
  timestamp: string
  is_final: boolean
}

type BackendSessionDetail = BackendSession & {
  messages?: BackendMessage[]
  message_count?: number
}

function datedMarkdownPath(userDir: string, session: BackendSession, start: string): string {
  const title =
    (session.title?.trim() || 'untitled')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'untitled'
  const datetime = `${start.slice(0, 10)}-${start.slice(11, 16).replace(':', '-')}`
  return join(userDir, `${datetime}-${title}-${session.id}.md`)
}

export async function syncConversationsToMarkdown(
  connection: { backendBaseUrl: string; accessToken: string; userId: string },
  signal: AbortSignal,
  log: (message: string) => void,
  root = join(homedir(), '.mira'),
) {
  const backendGet = (path: string) => fetch(connection.backendBaseUrl + path, {
    headers: { Authorization: `Bearer ${connection.accessToken}`, Accept: 'application/json' },
    signal,
  })
  if (signal.aborted) return
  const listRes = await backendGet('/messages/list')
  if (signal.aborted) return
  if (!listRes.ok) {
    log(`conversation sync backend error status=${listRes.status}`)
    return
  }
  const data = (await listRes.json()) as { sessions: BackendSession[] }
  if (signal.aborted) return
  const sessions = data.sessions ?? []
  const userDir = join(root, connection.userId)
  mkdirSync(userDir, { recursive: true })
  for (const session of sessions) {
    const undated = join(userDir, `undated-${encodeURIComponent(session.id)}.md`)
    const path = session.start_time ? datedMarkdownPath(userDir, session, session.start_time) : undated
    if (existsSync(path) || (path !== undated && existsSync(undated))) {
      continue
    }
    const detailRes = await backendGet(
      `/messages/sessions/${encodeURIComponent(session.id)}?include_messages=true`,
    )
    if (signal.aborted) return
    if (!detailRes.ok) {
      log(`session sync failed id=${session.id} status=${detailRes.status}`)
      continue
    }
    const detail = (await detailRes.json()) as BackendSessionDetail
    if (signal.aborted) return
    const messages = detail.messages ?? []
    const markdown = [
      `# ${detail.title?.trim() || '(untitled)'}`,
      '',
      `Session ID: ${detail.id}`,
      `Time: ${detail.start_time ?? '(no start time)'} -> ${detail.end_time ?? '(no end time)'}`,
      detail.summary?.trim() ? `Summary: ${detail.summary.trim()}` : null,
      '',
      '## Transcript',
      '',
      ...messages.map((m) => `[${m.timestamp}] speaker ${m.speaker}: ${m.text}`),
      '',
    ].filter(Boolean).join('\n')
    writeFileSync(path, markdown, 'utf8')
  }
  log(`conversation sync OK user_id=${connection.userId} sessions=${sessions.length}`)
}
