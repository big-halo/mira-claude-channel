import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs'

const CLOUDFLARED_DIR = `${process.env.HOME}/.mira-mcp`
const CLOUDFLARED_PATH = `${CLOUDFLARED_DIR}/cloudflared`
const TUNNEL_CACHE_DIR = `${CLOUDFLARED_DIR}/tunnels`
// Persisted on disk so the SessionStart hook can read the current tunnel URL
// without talking to the MCP server.
const TUNNEL_URL_FILE = `${CLOUDFLARED_DIR}/tunnel.url`

function tunnelCachePath(deviceId: string) {
  return `${TUNNEL_CACHE_DIR}/${deviceId}.json`
}

let tunnelUrl: string | null = null
let tunnelError: string | null = null

export const getTunnelUrl = () => tunnelUrl
export const getTunnelError = () => tunnelError

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

async function ensureCloudflared(log: (msg: string) => void): Promise<string> {
  if (await Bun.file(CLOUDFLARED_PATH).exists()) return CLOUDFLARED_PATH
  log('downloading cloudflared (first run)...')
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  const os = process.platform === 'darwin' ? 'darwin' : 'linux'
  const ext = os === 'darwin' ? '.tgz' : ''
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-${os}-${arch}${ext}`
  await Bun.spawn(['mkdir', '-p', CLOUDFLARED_DIR]).exited
  if (os === 'darwin') {
    await Bun.spawn(['sh', '-c', `curl -sL ${url} | tar xz -C ${CLOUDFLARED_DIR}`]).exited
  } else {
    await Bun.spawn(['sh', '-c', `curl -sL ${url} -o ${CLOUDFLARED_PATH} && chmod +x ${CLOUDFLARED_PATH}`]).exited
  }
  log('cloudflared downloaded')
  return CLOUDFLARED_PATH
}

type ProvisionResponse = { hostname: string; token: string }

type ProvisionOptions = {
  deviceId: string
  deviceLabel: string
  backendBaseUrl: string
  log: (msg: string) => void
  /**
   * Optional structured-event emitter. When provided, mid-session
   * cloudflared exits ship a `tunnel_closed` event to the backend so
   * triage can tell "tunnel was up, then went down" apart from
   * "tunnel never came up" (= existing `tunnel_error`).
   */
  emit?: (
    kind: string,
    payload?: Record<string, unknown>,
    level?: 'info' | 'warn' | 'error',
  ) => void
}

async function fetchProvisionedTunnel(opts: ProvisionOptions): Promise<ProvisionResponse | null> {
  try {
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
      return null
    }
    const data = (await res.json()) as ProvisionResponse
    if (!data?.hostname || !data?.token) {
      opts.log(`tunnel provision malformed response`)
      return null
    }
    return data
  } catch (err) {
    opts.log(`tunnel provision error: ${(err as Error).message}`)
    return null
  }
}

function readProvisionedCache(deviceId: string, log: (msg: string) => void): ProvisionResponse | null {
  const path = tunnelCachePath(deviceId)
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ProvisionResponse
    if (!parsed?.hostname || !parsed?.token) return null
    return parsed
  } catch (err) {
    log(`tunnel cache read failed: ${(err as Error).message}`)
    return null
  }
}

function writeProvisionedCache(deviceId: string, data: ProvisionResponse, log: (msg: string) => void) {
  try {
    mkdirSync(TUNNEL_CACHE_DIR, { recursive: true })
    writeFileSync(tunnelCachePath(deviceId), JSON.stringify(data), { mode: 0o600 })
  } catch (err) {
    log(`tunnel cache write failed: ${(err as Error).message}`)
  }
}

export async function openProvisionedTunnel(opts: ProvisionOptions): Promise<void> {
  clearTunnelUrlFile(opts.log)

  let provisioned = readProvisionedCache(opts.deviceId, opts.log)
  if (provisioned) {
    opts.log(`tunnel cache hit hostname=${provisioned.hostname}`)
  } else {
    provisioned = await fetchProvisionedTunnel(opts)
    if (provisioned) {
      writeProvisionedCache(opts.deviceId, provisioned, opts.log)
      opts.log(`tunnel provisioned hostname=${provisioned.hostname}`)
    }
  }

  if (!provisioned) {
    tunnelError = 'Could not provision tunnel from backend. Reconnect to retry.'
    return
  }

  const binary = await ensureCloudflared(opts.log)
  const url = `https://${provisioned.hostname}`
  tunnelUrl = url
  tunnelError = null
  writeTunnelUrlFile(url, opts.log)

  opts.log(`tunnel opening (provisioned) hostname=${provisioned.hostname}`)
  const proc = Bun.spawn(
    [binary, 'tunnel', 'run', '--token', provisioned.token],
    {
      stderr: 'pipe',
      stdout: 'pipe',
      onExit: (_, code) => {
        const wasUp = tunnelUrl !== null
        opts.log(`cloudflared exited code=${code}`)
        tunnelUrl = null
        tunnelError = 'Tunnel closed. Restart the plugin to reconnect.'
        clearTunnelUrlFile(opts.log)
        // Only emit if the tunnel was actually up before — if cloudflared
        // failed to start at all, the caller has already shipped `tunnel_error`.
        if (wasUp && opts.emit) {
          opts.emit(
            'tunnel_closed',
            { exit_code: code ?? null, hostname: provisioned?.hostname },
            'error',
          )
        }
      },
    },
  )

  ;(async () => {
    const decoder = new TextDecoder()
    for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
      opts.log(`cloudflared stderr ${decoder.decode(chunk).trim()}`)
    }
  })()

  const killChild = () => {
    try { proc.kill() } catch { /* best-effort */ }
  }
  process.once('exit', killChild)
  process.once('SIGTERM', killChild)
  process.once('SIGINT', killChild)
}
