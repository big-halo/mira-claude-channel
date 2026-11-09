import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncConversationsToMarkdown } from './conversation-sync'

const account = { userId: 'user-a', backendBaseUrl: 'https://example.invalid', accessToken: 'fixture' }
const session = { id: 's1', title: 'Example', start_time: '2026-01-02T12:30:00Z' }
const detail = { ...session, messages: [{ timestamp: '12:30', speaker: 1, text: 'Hello' }] }
const log = () => {}
let root: string
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mira-sync-'))
  fetchSpy = spyOn(globalThis, 'fetch')
})
afterEach(() => {
  fetchSpy.mockRestore()
  rmSync(root, { recursive: true, force: true })
})

test('saves the original connection’s transcript and skips an existing markdown file', async () => {
  const { signal } = new AbortController()
  fetchSpy.mockResolvedValueOnce(Response.json({ sessions: [session] }))
    .mockResolvedValueOnce(Response.json(detail))
    .mockResolvedValueOnce(Response.json({ sessions: [session] }))
  await syncConversationsToMarkdown(account, signal, log, root)
  await syncConversationsToMarkdown(account, signal, log, root)
  const directory = join(root, account.userId)
  const files = readdirSync(directory)
  expect(files).toHaveLength(1)
  expect(readFileSync(join(directory, files[0]), 'utf8')).toContain('[12:30] speaker 1: Hello')
  expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
    account.backendBaseUrl + '/messages/list',
    account.backendBaseUrl + '/messages/sessions/s1?include_messages=true',
    account.backendBaseUrl + '/messages/list',
  ])
  expect(fetchSpy.mock.calls.every(([, init]) =>
    init?.signal === signal && new Headers(init.headers).get('Authorization') === 'Bearer fixture')).toBe(true)
})

test('a disconnected listing cannot create a directory or start a detail fetch', async () => {
  const sync = new AbortController()
  const listing = Promise.withResolvers<Response>()
  fetchSpy.mockReturnValueOnce(listing.promise)
  const task = syncConversationsToMarkdown(account, sync.signal, log, root)
  sync.abort()
  listing.resolve(Response.json({ sessions: [session] }))
  await task
  expect(fetchSpy).toHaveBeenCalledTimes(1)
  expect(existsSync(join(root, account.userId))).toBe(false)
})

test('reconnecting while decoding a detail stops the old write and later detail requests', async () => {
  const sync = new AbortController()
  const waiting = Promise.withResolvers<void>()
  const decoded = Promise.withResolvers<typeof detail>()
  const response = Response.json({})
  response.json = () => { waiting.resolve(); return decoded.promise }
  fetchSpy.mockResolvedValueOnce(Response.json({ sessions: [session, { ...session, id: 's2' }] }))
    .mockResolvedValueOnce(response)
  const task = syncConversationsToMarkdown(account, sync.signal, log, root)
  await waiting.promise
  sync.abort()
  decoded.resolve(detail)
  await task
  expect(readdirSync(join(root, account.userId))).toEqual([])
  expect(fetchSpy).toHaveBeenCalledTimes(2)
})

test('an undated recording syncs alongside dated recordings and keeps its file when a date arrives', async () => {
  const { signal } = new AbortController()
  const undated = { id: 's0', title: 'First recording', start_time: null }
  fetchSpy.mockResolvedValueOnce(Response.json({ sessions: [undated, session] }))
    .mockResolvedValueOnce(Response.json({ ...undated, messages: detail.messages }))
    .mockResolvedValueOnce(Response.json(detail))
    .mockResolvedValueOnce(Response.json({ sessions: [{ ...undated, start_time: session.start_time }, session] }))
  await syncConversationsToMarkdown(account, signal, log, root)
  await syncConversationsToMarkdown(account, signal, log, root)
  const directory = join(root, account.userId)
  expect(readdirSync(directory).sort()).toEqual(['2026-01-02-12-30-example-s1.md', 'undated-s0.md'])
  expect(readFileSync(join(directory, 'undated-s0.md'), 'utf8')).toContain('(no start time)')
  expect(fetchSpy).toHaveBeenCalledTimes(4)
})

test('an empty undated row waits for its completed transcript', async () => {
  const { signal } = new AbortController()
  const early = { id: session.id, title: session.title, start_time: null }
  const completed = { ...detail, end_time: '2026-01-02T12:45:00Z' }
  fetchSpy.mockResolvedValueOnce(Response.json({ sessions: [early] }))
    .mockResolvedValueOnce(Response.json(early))
    .mockResolvedValueOnce(Response.json({ sessions: [completed] }))
    .mockResolvedValueOnce(Response.json(completed))
  await syncConversationsToMarkdown(account, signal, log, root)
  const directory = join(root, account.userId)
  expect(readdirSync(directory)).toEqual([])
  await syncConversationsToMarkdown(account, signal, log, root)
  const files = readdirSync(directory)
  expect(files).toHaveLength(1)
  const note = readFileSync(join(directory, files[0]), 'utf8')
  expect(note).toContain('Hello')
  expect(note).toContain(completed.end_time)
})

test.each([false, true])('recovers an old placeholder and respects a local edit during the request (edited=%s)', async (edited) => {
  const directory = join(root, account.userId)
  mkdirSync(directory)
  const path = join(directory, 'undated-s1.md')
  const empty = '# Example\nSession ID: s1\nTime: (no start time) -> (no end time)\n## Transcript'
  writeFileSync(path, empty)
  const completed = { ...detail, end_time: '2026-01-02T12:45:00Z' }
  fetchSpy.mockResolvedValueOnce(Response.json({ sessions: [completed] }))
    .mockImplementationOnce(async () => {
      if (edited) writeFileSync(path, 'My local note')
      return Response.json(completed)
    })
  await syncConversationsToMarkdown(account, new AbortController().signal, log, root)
  expect(readdirSync(directory)).toEqual(['undated-s1.md'])
  const note = readFileSync(path, 'utf8')
  if (edited) expect(note).toBe('My local note')
  else {
    expect(note).toContain('Hello')
    expect(note).toContain(completed.end_time)
  }
})

test('a note edited before sync is preserved without a detail request', async () => {
  const directory = join(root, account.userId)
  mkdirSync(directory)
  const path = join(directory, 'undated-s1.md')
  writeFileSync(path, 'My local note')
  fetchSpy.mockResolvedValueOnce(Response.json({ sessions: [session] }))
  await syncConversationsToMarkdown(account, new AbortController().signal, log, root)
  expect(fetchSpy).toHaveBeenCalledTimes(1)
  expect(readFileSync(path, 'utf8')).toBe('My local note')
})

test('a note created during a detail request wins', async () => {
  const path = join(root, account.userId, '2026-01-02-12-30-example-s1.md')
  fetchSpy.mockResolvedValueOnce(Response.json({ sessions: [session] }))
    .mockImplementationOnce(async () => {
      writeFileSync(path, 'My local note')
      return Response.json(detail)
    })
  await syncConversationsToMarkdown(account, new AbortController().signal, log, root)
  expect(readFileSync(path, 'utf8')).toBe('My local note')
})

test('a mismatched detail cannot be saved in another session’s note', async () => {
  fetchSpy.mockResolvedValueOnce(Response.json({ sessions: [session] }))
    .mockResolvedValueOnce(Response.json({ ...detail, id: 's2' }))
  await syncConversationsToMarkdown(account, new AbortController().signal, log, root)
  expect(readdirSync(join(root, account.userId))).toEqual([])
})

test('an old empty note can recover when speech arrives before timestamps', async () => {
  const early = { id: session.id, title: session.title }
  const directory = join(root, account.userId)
  mkdirSync(directory)
  const path = join(directory, 'undated-s1.md')
  writeFileSync(path, '# Example\nSession ID: s1\nTime: (no start time) -> (no end time)\n## Transcript')
  fetchSpy.mockResolvedValueOnce(Response.json({ sessions: [early] }))
    .mockResolvedValueOnce(Response.json({ ...early, messages: detail.messages }))
  await syncConversationsToMarkdown(account, new AbortController().signal, log, root)
  expect(readdirSync(directory)).toEqual(['undated-s1.md'])
  expect(readFileSync(path, 'utf8')).toContain('Hello')
})
