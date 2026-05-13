import { mkdirSync, writeFileSync, unlinkSync } from 'fs'
import { miraPath } from './paths'

const CLOUDFLARED_DIR = miraPath()
const CLOUDFLARED_PATH = process.platform === 'win32'
  ? `${CLOUDFLARED_DIR}/cloudflared.exe`
  : `${CLOUDFLARED_DIR}/cloudflared`
// Persisted on disk so the SessionStart hook can read the current tunnel URL
// without talking to the MCP server.
const TUNNEL_URL_FILE = `${CLOUDFLARED_DIR}/tunnel.url`
const TUNNEL_ERROR_FILE = `${CLOUDFLARED_DIR}/tunnel.error`
const CLOUDFLARED_READY_TIMEOUT_MS = 30_000
const CLOUDFLARED_LOG_TAIL_SIZE = 8

let tunnelUrl: string | null = null
let tunnelError: string | null = null

export const getTunnelUrl = () => tunnelUrl
export const getTunnelError = () => tunnelError

function clearTunnelErrorFile(log: (msg: string) => void) {
  try {
    unlinkSync(TUNNEL_ERROR_FILE)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code && code !== 'ENOENT') {
      log(`tunnel.error unlink failed: ${(err as Error).message}`)
    }
  }
}

function clearTunnelUrlFile(log: (msg: string) => void) {
  try {
    unlinkSync(TUNNEL_URL_FILE)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code && code !== 'ENOENT') {
      log(`tunnel.url unlink failed: ${(err as Error).message}`)
    }
  }
}

function writeTunnelUrlFile(url: string, log: (msg: string) => void) {
  try {
    mkdirSync(CLOUDFLARED_DIR, { recursive: true })
    writeFileSync(TUNNEL_URL_FILE, url)
  } catch (err) {
    log(`tunnel.url write failed: ${(err as Error).message}`)
  }
}

function setTunnelError(message: string, log: (msg: string) => void) {
  tunnelError = message
  try {
    mkdirSync(CLOUDFLARED_DIR, { recursive: true })
    writeFileSync(TUNNEL_ERROR_FILE, message)
  } catch (err) {
    log(`tunnel.error write failed: ${(err as Error).message}`)
  }
}

async function downloadFile(url: string, path: string) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download failed status=${res.status}`)
  await Bun.write(path, await res.arrayBuffer())
}

function cloudflaredReady(line: string): boolean {
  return /Registered tunnel connection/i.test(line) ||
    /connection .* registered/i.test(line)
}

function trimLogTail(lines: string[]) {
  if (lines.length > CLOUDFLARED_LOG_TAIL_SIZE) {
    lines.splice(0, lines.length - CLOUDFLARED_LOG_TAIL_SIZE)
  }
}

function summarizeTail(lines: string[]): string {
  return lines.join(' | ').slice(0, 500)
}

async function ensureCloudflared(log: (msg: string) => void): Promise<string> {
  if (await Bun.file(CLOUDFLARED_PATH).exists()) return CLOUDFLARED_PATH
  log('downloading cloudflared (first run)...')
  mkdirSync(CLOUDFLARED_DIR, { recursive: true })

  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  if (process.platform === 'win32') {
    const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-${arch}.exe`
    await downloadFile(url, CLOUDFLARED_PATH)
  } else if (process.platform === 'darwin') {
    const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${arch}.tgz`
    await Bun.spawn(['sh', '-c', `curl -sL ${url} | tar xz -C ${CLOUDFLARED_DIR}`]).exited
  } else {
    const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}`
    await downloadFile(url, CLOUDFLARED_PATH)
    await Bun.spawn(['chmod', '+x', CLOUDFLARED_PATH]).exited
  }
  log('cloudflared downloaded')
  return CLOUDFLARED_PATH
}

type ProvisionResponse = { hostname: string; token: string }
type TunnelEventLevel = 'info' | 'warn' | 'error'

type ProvisionOptions = {
  deviceId: string
  deviceLabel: string
  backendBaseUrl: string
  log: (msg: string) => void
  emit?: (kind: string, payload?: Record<string, unknown>, level?: TunnelEventLevel) => void
}

function emitTunnelEvent(
  opts: ProvisionOptions,
  kind: string,
  payload: Record<string, unknown> = {},
  level: TunnelEventLevel = 'info',
) {
  opts.emit?.(kind, payload, level)
}

function sanitizeCloudflaredLog(value: string): string {
  return value
    .replace(/(--token\s+)[^\s]+/gi, '$1[redacted]')
    .replace(/\btoken[=:][^\s,]+/gi, 'token=[redacted]')
    .slice(0, 500)
}

async function fetchProvisionedTunnel(opts: ProvisionOptions): Promise<ProvisionResponse | null> {
  try {
    emitTunnelEvent(opts, 'tunnel_provision_start', { backend_base_url: opts.backendBaseUrl })
    const res = await fetch(`${opts.backendBaseUrl}/tunnels/provision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_id: opts.deviceId,
        device_label: opts.deviceLabel,
      }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      opts.log(`tunnel provision failed status=${res.status} body=${body.slice(0, 200)}`)
      emitTunnelEvent(
        opts,
        'tunnel_provision_failed',
        { status: res.status, body_len: body.length },
        'error',
      )
      return null
    }
    const data = (await res.json()) as ProvisionResponse
    if (!data?.hostname || !data?.token) {
      opts.log(`tunnel provision malformed response`)
      emitTunnelEvent(opts, 'tunnel_provision_malformed', {}, 'error')
      return null
    }
    emitTunnelEvent(opts, 'tunnel_provision_ok', { hostname: data.hostname })
    return data
  } catch (err) {
    opts.log(`tunnel provision error: ${(err as Error).message}`)
    emitTunnelEvent(opts, 'tunnel_provision_error', { error: (err as Error).message }, 'error')
    return null
  }
}

export async function openProvisionedTunnel(opts: ProvisionOptions): Promise<void> {
  clearTunnelUrlFile(opts.log)
  clearTunnelErrorFile(opts.log)

  const provisioned = await fetchProvisionedTunnel(opts)
  if (provisioned) {
    opts.log(`tunnel provisioned hostname=${provisioned.hostname}`)
  }

  if (!provisioned) {
    setTunnelError('Could not provision tunnel from backend. Reconnect to retry.', opts.log)
    emitTunnelEvent(opts, 'tunnel_unavailable', { stage: 'provision', error: tunnelError }, 'error')
    return
  }

  let binary: string
  try {
    binary = await ensureCloudflared(opts.log)
  } catch (err) {
    setTunnelError(`Cloudflared setup failed: ${(err as Error).message}`, opts.log)
    opts.log(`cloudflared setup failed: ${(err as Error).message}`)
    emitTunnelEvent(
      opts,
      'cloudflared_setup_failed',
      { hostname: provisioned.hostname, error: (err as Error).message },
      'error',
    )
    return
  }
  const url = `https://${provisioned.hostname}`

  opts.log(`tunnel opening (provisioned) hostname=${provisioned.hostname}`)
  emitTunnelEvent(opts, 'cloudflared_start', { hostname: provisioned.hostname })
  const logTail: string[] = []
  let ready = false
  let settleReady: (value: boolean) => void = () => {}
  const readyPromise = new Promise<boolean>((resolve) => {
    settleReady = resolve
  })
  const readyTimer = setTimeout(() => {
    if (ready) return
    setTunnelError(
      `Cloudflared did not confirm a tunnel connection within ${CLOUDFLARED_READY_TIMEOUT_MS / 1000}s. Restart Claude Code to retry.`,
      opts.log,
    )
    if (logTail.length) tunnelError += ` Last log: ${summarizeTail(logTail)}`
    opts.log(`cloudflared ready timeout hostname=${provisioned.hostname} tail=${summarizeTail(logTail)}`)
    emitTunnelEvent(
      opts,
      'cloudflared_ready_timeout',
      {
        hostname: provisioned.hostname,
        timeout_ms: CLOUDFLARED_READY_TIMEOUT_MS,
        log_tail: sanitizeCloudflaredLog(summarizeTail(logTail)),
      },
      'error',
    )
    settleReady(false)
  }, CLOUDFLARED_READY_TIMEOUT_MS)

  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(
      [binary, 'tunnel', 'run', '--token', provisioned.token],
      {
        stderr: 'pipe',
        stdout: 'pipe',
        onExit: (_, code) => {
          opts.log(`cloudflared exited code=${code}`)
          emitTunnelEvent(
            opts,
            'cloudflared_exit',
            { hostname: provisioned.hostname, code, ready },
            ready ? 'warn' : 'error',
          )
          tunnelUrl = null
          clearTunnelUrlFile(opts.log)
          if (!ready) {
            setTunnelError(
              `Cloudflared exited before the tunnel was ready (code ${code}). Restart Claude Code to retry.`,
              opts.log,
            )
            if (logTail.length) tunnelError += ` Last log: ${summarizeTail(logTail)}`
            emitTunnelEvent(
              opts,
              'tunnel_unavailable',
              {
                stage: 'cloudflared_exit_before_ready',
                hostname: provisioned.hostname,
                code,
                log_tail: sanitizeCloudflaredLog(summarizeTail(logTail)),
              },
              'error',
            )
            clearTimeout(readyTimer)
            settleReady(false)
          } else {
            tunnelError = 'Tunnel closed. Restart the plugin to reconnect.'
            emitTunnelEvent(
              opts,
              'tunnel_closed',
              { hostname: provisioned.hostname, error: tunnelError },
              'warn',
            )
          }
        },
      },
    )
  } catch (err) {
    clearTimeout(readyTimer)
    setTunnelError(`Cloudflared failed to start: ${(err as Error).message}`, opts.log)
    opts.log(`cloudflared spawn failed: ${(err as Error).message}`)
    emitTunnelEvent(
      opts,
      'cloudflared_start_failed',
      { hostname: provisioned.hostname, error: (err as Error).message },
      'error',
    )
    return
  }

  ;(async () => {
    const decoder = new TextDecoder()
    for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
      for (const line of decoder.decode(chunk).split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed) continue
        logTail.push(trimmed)
        trimLogTail(logTail)
        opts.log(`cloudflared stderr ${trimmed}`)
        if (/\b(ERR|error|failed|timeout)\b/i.test(trimmed)) {
          emitTunnelEvent(
            opts,
            'cloudflared_log_error',
            { hostname: provisioned.hostname, line: sanitizeCloudflaredLog(trimmed) },
            'warn',
          )
        }
        if (!ready && cloudflaredReady(trimmed)) {
          ready = true
          clearTimeout(readyTimer)
          emitTunnelEvent(opts, 'cloudflared_ready', { hostname: provisioned.hostname })
          settleReady(true)
        }
      }
    }
  })()

  const isReady = await readyPromise
  if (!isReady) {
    try { proc.kill() } catch { /* best-effort */ }
    tunnelUrl = null
    clearTunnelUrlFile(opts.log)
    return
  }

  tunnelUrl = url
  tunnelError = null
  clearTunnelErrorFile(opts.log)
  writeTunnelUrlFile(url, opts.log)
  opts.log(`tunnel ready hostname=${provisioned.hostname}`)

  const killChild = () => {
    try { proc.kill() } catch { /* best-effort */ }
  }
  process.once('exit', killChild)
  process.once('SIGTERM', killChild)
  process.once('SIGINT', killChild)
}
