import { mkdirSync, writeFileSync, unlinkSync } from 'fs'

const CLOUDFLARED_DIR = `${process.env.HOME}/.mira-mcp`
const CLOUDFLARED_PATH = `${CLOUDFLARED_DIR}/cloudflared`
// Persisted on disk so the SessionStart hook can read the current tunnel URL
// without talking to the MCP server.
const TUNNEL_URL_FILE = `${CLOUDFLARED_DIR}/tunnel.url`
const CLOUDFLARED_READY_TIMEOUT_MS = 30_000
const CLOUDFLARED_LOG_TAIL_SIZE = 8

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

export async function openProvisionedTunnel(opts: ProvisionOptions): Promise<void> {
  clearTunnelUrlFile(opts.log)

  const provisioned = await fetchProvisionedTunnel(opts)
  if (provisioned) {
    opts.log(`tunnel provisioned hostname=${provisioned.hostname}`)
  }

  if (!provisioned) {
    tunnelError = 'Could not provision tunnel from backend. Reconnect to retry.'
    return
  }

  let binary: string
  try {
    binary = await ensureCloudflared(opts.log)
  } catch (err) {
    tunnelError = `Cloudflared setup failed: ${(err as Error).message}`
    opts.log(`cloudflared setup failed: ${(err as Error).message}`)
    return
  }
  const url = `https://${provisioned.hostname}`

  opts.log(`tunnel opening (provisioned) hostname=${provisioned.hostname}`)
  const logTail: string[] = []
  let ready = false
  let settleReady: (value: boolean) => void = () => {}
  const readyPromise = new Promise<boolean>((resolve) => {
    settleReady = resolve
  })
  const readyTimer = setTimeout(() => {
    if (ready) return
    tunnelError = `Cloudflared did not confirm a tunnel connection within ${CLOUDFLARED_READY_TIMEOUT_MS / 1000}s. Restart Claude Code to retry.`
    if (logTail.length) tunnelError += ` Last log: ${summarizeTail(logTail)}`
    opts.log(`cloudflared ready timeout hostname=${provisioned.hostname} tail=${summarizeTail(logTail)}`)
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
          tunnelUrl = null
          clearTunnelUrlFile(opts.log)
          if (!ready) {
            tunnelError = `Cloudflared exited before the tunnel was ready (code ${code}). Restart Claude Code to retry.`
            if (logTail.length) tunnelError += ` Last log: ${summarizeTail(logTail)}`
            clearTimeout(readyTimer)
            settleReady(false)
          } else {
            tunnelError = 'Tunnel closed. Restart the plugin to reconnect.'
          }
        },
      },
    )
  } catch (err) {
    clearTimeout(readyTimer)
    tunnelError = `Cloudflared failed to start: ${(err as Error).message}`
    opts.log(`cloudflared spawn failed: ${(err as Error).message}`)
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
        if (!ready && cloudflaredReady(trimmed)) {
          ready = true
          clearTimeout(readyTimer)
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
  writeTunnelUrlFile(url, opts.log)
  opts.log(`tunnel ready hostname=${provisioned.hostname}`)

  const killChild = () => {
    try { proc.kill() } catch { /* best-effort */ }
  }
  process.once('exit', killChild)
  process.once('SIGTERM', killChild)
  process.once('SIGINT', killChild)
}
