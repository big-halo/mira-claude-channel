import { join } from 'path'
import { homedir } from 'os'
import { mkdirSync, readFileSync, rmSync, existsSync } from 'fs'

const MARKETPLACE_NAME = 'mira-marketplace'
const PLUGIN_NAME = 'mira'
const RELEASE_BASE_URL =
  process.env.MIRA_PLUGIN_RELEASE_BASE_URL ??
  'https://github.com/big-halo/mira-claude-channel/releases/latest/download'
const REMOTE_PACKAGE_URL = `${RELEASE_BASE_URL}/package.json`
const REMOTE_ARCHIVE_URL = `${RELEASE_BASE_URL}/mira.tgz`
const LOCAL_PLUGIN_DIR = `${homedir()}/.local/share/mira/mira`
const DEFAULT_UPDATE_CHECK_TIMEOUT_MS = 3_000

export const UPDATE_NOTICE =
  'Plugin update required: run the Mira installer again, then restart Claude'

export const TUNNEL_BLOCKED_MESSAGE =
  'Mira tunnel URL: not available — plugin update required.\n' +
  'To get your URL: run the Mira installer again, then restart Claude'

export const AUTO_UPDATE_RELOAD_MESSAGE =
  'Mira plugin was out of date — auto-updated in the background.\n' +
  'Run /reload-plugins now to apply the update and get your tunnel URL.'

export type AutoUpdateResult = { ok: true } | { ok: false; reason: string }

function resolveClaudeBin(): string | null {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN
  const which = Bun.spawnSync(['which', 'claude'], { stdout: 'pipe', stderr: 'pipe' })
  if (which.exitCode === 0) {
    const path = new TextDecoder().decode(which.stdout).trim()
    if (path) return path
  }
  const fallback = `${process.env.HOME}/.local/bin/claude`
  return existsSync(fallback) ? fallback : null
}

export function autoUpdatePlugin(): AutoUpdateResult {
  try {
    const tmpDir = `${homedir()}/.local/share/mira/.update-${Date.now()}`
    mkdirSync(tmpDir, { recursive: true })

    const archivePath = `${tmpDir}/mira-plugin.tgz`
    let result = Bun.spawnSync(['curl', '-fsSL', REMOTE_ARCHIVE_URL, '-o', archivePath], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (result.exitCode !== 0) {
      const stderr = new TextDecoder().decode(result.stderr).trim()
      rmSync(tmpDir, { recursive: true, force: true })
      return { ok: false, reason: stderr || `curl exit ${result.exitCode}` }
    }

    rmSync(LOCAL_PLUGIN_DIR, { recursive: true, force: true })
    mkdirSync(LOCAL_PLUGIN_DIR, { recursive: true })
    result = Bun.spawnSync(['tar', '-xzf', archivePath, '-C', LOCAL_PLUGIN_DIR], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    rmSync(tmpDir, { recursive: true, force: true })
    if (result.exitCode !== 0) {
      const stderr = new TextDecoder().decode(result.stderr).trim()
      return { ok: false, reason: stderr || `tar exit ${result.exitCode}` }
    }

    result = Bun.spawnSync(['bun', 'install'], {
      cwd: LOCAL_PLUGIN_DIR,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (result.exitCode !== 0) {
      const stderr = new TextDecoder().decode(result.stderr).trim()
      return { ok: false, reason: stderr || `bun install exit ${result.exitCode}` }
    }

    const claudeBin = resolveClaudeBin()
    if (!claudeBin) {
      return { ok: false, reason: 'claude binary not found on PATH' }
    }
    result = Bun.spawnSync(
      [claudeBin, 'plugin', 'update', `${PLUGIN_NAME}@${MARKETPLACE_NAME}`],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    if (result.exitCode === 0) return { ok: true }
    const stderr = new TextDecoder().decode(result.stderr).trim()
    return { ok: false, reason: stderr || `exit ${result.exitCode}` }
  } catch (err) {
    return { ok: false, reason: (err as Error).message }
  }
}

export type UpdateState = {
  checkedAt: number
  stale: boolean
  localVersion: string | null
  remoteVersion: string | null
}

/** Show the tunnel URL only when the plugin is not stale. */
export function canShowTunnelUrl(state: UpdateState): boolean {
  return !state.stale
}


function localPluginVersion(pluginRoot: string): string | null {
  // server.ts lives at plugin root; hooks live one level deeper in hooks/
  const candidates = [
    join(pluginRoot, 'package.json'),
    join(pluginRoot, '..', 'package.json'),
  ]
  for (const p of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(p, 'utf8'))
      if (typeof pkg.version === 'string') return pkg.version
    } catch { /* try next */ }
  }
  return null
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, {
      signal: controller.signal,
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' },
    })
  } finally {
    clearTimeout(timer)
  }
}

export async function checkPluginUpdateState({
  pluginRoot,
  timeoutMs = DEFAULT_UPDATE_CHECK_TIMEOUT_MS,
}: {
  pluginRoot: string
  timeoutMs?: number
}): Promise<UpdateState> {
  const localVersion = localPluginVersion(pluginRoot)

  const res = await fetchWithTimeout(`${REMOTE_PACKAGE_URL}?t=${Date.now()}`, timeoutMs)
  if (!res.ok) throw new Error(`remote_package_http_${res.status}`)

  const data = await res.json() as { content?: string; version?: unknown }
  const remoteVersion = typeof data.version === 'string' ? data.version : null

  const stale =
    localVersion !== null &&
    remoteVersion !== null &&
    localVersion !== remoteVersion

  return { checkedAt: Date.now(), stale, localVersion, remoteVersion }
}

export function appendUpdateNotice(text: string, state: UpdateState): string {
  if (!state.stale || text.includes(UPDATE_NOTICE)) return text
  return `${text.trimEnd()}\n\n${UPDATE_NOTICE}`
}
