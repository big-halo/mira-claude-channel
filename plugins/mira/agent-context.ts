import { homedir } from 'os'
import { join } from 'path'

export type AgentMessage = {
  speaker?: number
  content?: string
  text?: string
  speaker_label?: string
}

export type AgentMemory = {
  session_id?: string
  title?: string
  summary?: string
  start_time?: string
}

export type AgentSessionBootstrap = {
  bootstrap_reason?: string
  session_id?: string
  session_title?: string
  user_id?: string
  first_name?: string
  last_name?: string
  user_local_time?: string
  user_timezone?: string
  location?: {
    latitude?: number
    longitude?: number
    address?: string
  }
  participants?: string[]
  recent_memories?: AgentMemory[]
  messages?: AgentMessage[]
  skill_description?: string
  attachment_ids?: string[]
  length?: string
}

export const SESSION_BOOTSTRAP_FILE = join(homedir(), '.mira', 'session-bootstrap.json')

export function displayName(message: AgentMessage): string {
  const label = typeof message.speaker_label === 'string' ? message.speaker_label.trim() : ''
  if (label) return label
  if (message.speaker === 0) return 'User'
  if (message.speaker === -1) return 'Mira'
  if (typeof message.speaker === 'number' && message.speaker > 0) {
    return `Speaker ${message.speaker}`
  }
  return 'Speaker'
}

export function formatConversationTranscript(messages: AgentMessage[]): string {
  return messages
    .map((message) => {
      const text = (message.content ?? message.text ?? '').toString().trim()
      if (!text) return null
      return `${displayName(message)}: ${text}`
    })
    .filter((line): line is string => Boolean(line))
    .join('\n')
}

export function summarizeSessionBootstrap(payload: AgentSessionBootstrap): string {
  const lines: string[] = ['Mira session bootstrap from the iOS app:']

  if (payload.bootstrap_reason) {
    lines.push(`Bootstrap reason: ${payload.bootstrap_reason}`)
  }
  if (payload.session_id) {
    lines.push(`Active session ID: ${payload.session_id}`)
  }
  if (payload.session_title?.trim()) {
    lines.push(`Active session title: ${payload.session_title.trim()}`)
  }

  const userBits = [payload.first_name, payload.last_name]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean)
  if (userBits.length > 0) {
    lines.push(`User name: ${userBits.join(' ')}`)
  }
  if (payload.user_id) {
    lines.push(`User ID: ${payload.user_id}`)
  }
  if (payload.user_local_time) {
    lines.push(`User local time: ${payload.user_local_time}`)
  }
  if (payload.user_timezone) {
    lines.push(`User timezone: ${payload.user_timezone}`)
  }

  const location = payload.location
  if (location && typeof location === 'object') {
    const locationBits: string[] = []
    if (typeof location.address === 'string' && location.address.trim()) {
      locationBits.push(location.address.trim())
    }
    if (typeof location.latitude === 'number' && typeof location.longitude === 'number') {
      locationBits.push(`GPS ${location.latitude}, ${location.longitude}`)
    }
    if (locationBits.length > 0) {
      lines.push(`User location: ${locationBits.join(' | ')}`)
    }
  }

  if (Array.isArray(payload.participants) && payload.participants.length > 0) {
    lines.push(`People in the current session: ${payload.participants.join(', ')}`)
  }
  if (payload.skill_description?.trim()) {
    lines.push(`Active skill: ${payload.skill_description.trim()}`)
  }
  if (Array.isArray(payload.attachment_ids) && payload.attachment_ids.length > 0) {
    lines.push(`Selected attachment IDs: ${payload.attachment_ids.join(', ')}`)
  }
  if (payload.length) {
    lines.push(`Requested response length: ${payload.length}`)
  }

  if (Array.isArray(payload.recent_memories) && payload.recent_memories.length > 0) {
    lines.push('', 'Recent remembered sessions:')
    for (const memory of payload.recent_memories) {
      const title = memory.title?.trim() || '(untitled)'
      const summary = memory.summary?.trim()
      const when = memory.start_time ? ` [${memory.start_time}]` : ''
      lines.push(`- ${title}${when}${summary ? `: ${summary}` : ''}`)
    }
  }

  const transcript = formatConversationTranscript(payload.messages ?? [])
  if (transcript) {
    lines.push('', 'Current session transcript so far:', transcript)
  }

  return lines.join('\n').slice(0, 9000)
}

export function buildChannelMeta(payload: AgentSessionBootstrap): Record<string, string> {
  const meta: Record<string, string> = {}
  if (payload.session_id) meta.session_id = payload.session_id
  if (payload.session_title?.trim()) meta.session_title = payload.session_title.trim()
  if (payload.user_local_time) meta.user_local_time = payload.user_local_time
  if (payload.user_timezone) meta.user_timezone = payload.user_timezone
  if (payload.first_name?.trim()) meta.user_first_name = payload.first_name.trim()
  if (payload.last_name?.trim()) meta.user_last_name = payload.last_name.trim()
  if (payload.skill_description?.trim()) meta.skill_description = payload.skill_description.trim()
  if (payload.length) meta.response_length = payload.length

  const location = payload.location
  if (location && typeof location === 'object') {
    if (typeof location.latitude === 'number') meta.user_latitude = String(location.latitude)
    if (typeof location.longitude === 'number') meta.user_longitude = String(location.longitude)
    if (typeof location.address === 'string' && location.address.trim()) {
      meta.user_address = location.address.trim()
    }
  }

  if (Array.isArray(payload.participants) && payload.participants.length > 0) {
    meta.participants = payload.participants.join(', ')
  }

  const transcript = formatConversationTranscript(payload.messages ?? [])
  if (transcript) {
    meta.conversation_transcript = transcript.slice(0, 4000)
  }

  if (Array.isArray(payload.recent_memories) && payload.recent_memories.length > 0) {
    meta.recent_memories = payload.recent_memories
      .map((memory) => {
        const title = memory.title?.trim() || '(untitled)'
        const summary = memory.summary?.trim()
        return summary ? `${title}: ${summary}` : title
      })
      .join(' | ')
      .slice(0, 4000)
  }

  return meta
}

export function buildChannelContent(payload: AgentSessionBootstrap): string {
  const messages = payload.messages ?? []
  const last = messages[messages.length - 1]
  const userText = (last?.content ?? last?.text ?? '').toString().trim()
  const prior = messages.slice(0, -1)
  const transcript = formatConversationTranscript(prior)

  if (!transcript) {
    return userText
  }

  return [
    'Current session transcript:',
    transcript,
    '',
    'Latest user message:',
    userText,
  ].join('\n')
}
