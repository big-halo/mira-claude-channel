import { mkdirSync, writeFileSync, unlinkSync } from 'fs'
import { miraPath } from './paths'

const CLOUDFLARED_DIR = miraPath()
const CLOUDFLARED_BIN = process.platform === 'win32'
  ? miraPath('cloudflared.exe')
  : miraPath('cloudflared')
const TUNNEL_URL_FILE = miraPath('tunnel.url')
const TUNNEL_ERROR_FILE = miraPath('tunnel.error')

let tunnelUrl: string | null = null
let tunnelError: string | null = null

export const getTunnelUrl = () => tunnelUrl
export const getTunnelError = () => tunnelError

function clearFile(path: string, log: (msg: string) => void) {
  try { unlinkSync(path) } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code && code !== 'ENOENT') log(`unlink ${path} failed: ${(err as Error).message}`)
  }
}

function writeFile(path: string, content: string, log: (msg: string) => void) {
  try { mkdirSync(CLOUDFLARED_DIR, { recursive: true }); writeFileSync(path, content) }
  catch (err) { log(`write ${path} failed: ${(err as Error).message}`) }
}

async function ensureCloudflared(log: (msg: string) => void): Promise<string | null> {
  // 1. Vendored binary already present
  // Bun.spawnSync throws on Windows if the binary doesn't exist (vs returning non-zero)
  try {
    if (Bun.spawnSync([CLOUDFLARED_BIN, '--version']).exitCode === 0) return CLOUDFLARED_BIN
  } catch { /* binary not found, fall through */ }

  // 2. Fall back to system PATH
  const lookup = process.platform === 'win32' ? 'where' : 'which'
  try {
    const onPath = new TextDecoder()
      .decode(Bun.spawnSync([lookup, 'cloudflared']).stdout)
      .trim().split(/\r?\n/)[0]
    if (onPath) return onPath
  } catch { /* not on PATH */ }

  // 3. Auto-download via fetch() — no sh/curl, works on Windows
  log('cloudflared not found, downloading...')
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  const url = process.platform === 'win32'
    ? `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-${arch}.exe`
    : process.platform === 'darwin'
      ? `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${arch}.tgz`
      : `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}`
  try {
    mkdirSync(CLOUDFLARED_DIR, { recursive: true })
    const res = await fetch(url)
    if (!res.ok) throw new Error(`download status=${res.status}`)
    if (process.platform === 'darwin') {
      const tmp = CLOUDFLARED_BIN + '.tgz'
      await Bun.write(tmp, await res.arrayBuffer())
      Bun.spawnSync(['tar', 'xz', '-C', CLOUDFLARED_DIR, '-f', tmp])
    } else {
      await Bun.write(CLOUDFLARED_BIN, await res.arrayBuffer())
      if (process.platform !== 'win32') Bun.spawnSync(['chmod', '+x', CLOUDFLARED_BIN])
    }
    log(`cloudflared downloaded to ${CLOUDFLARED_BIN}`)
    return CLOUDFLARED_BIN
  } catch (err) {
    log(`cloudflared download failed: ${(err as Error).message}`)
    return null
  }
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
      body: JSON.stringify({ device_id: opts.deviceId, device_label: opts.deviceLabel }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      opts.log(`tunnel provision failed status=${res.status} body=${body}`)
      return null
    }
    const data = (await res.json()) as ProvisionResponse
    if (!data?.hostname || !data?.token) { opts.log('tunnel provision malformed response'); return null }
    return data
  } catch (err) {
    opts.log(`tunnel provision error: ${(err as Error).stack ?? (err as Error).message}`)
    return null
  }
}

export async function openProvisionedTunnel(opts: ProvisionOptions): Promise<void> {
  clearFile(TUNNEL_URL_FILE, opts.log)
  clearFile(TUNNEL_ERROR_FILE, opts.log)

  const provisioned = await fetchProvisionedTunnel(opts)
  if (!provisioned) {
    tunnelError = 'Could not provision tunnel from backend. Reconnect to retry.'
    writeFile(TUNNEL_ERROR_FILE, tunnelError, opts.log)
    return
  }
  opts.log(`tunnel provisioned hostname=${provisioned.hostname}`)

  const binary = await ensureCloudflared(opts.log)
  if (!binary) {
    tunnelError = 'cloudflared could not be found or downloaded. See https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/'
    writeFile(TUNNEL_ERROR_FILE, tunnelError, opts.log)
    return
  }
  opts.log(`cloudflared found at ${binary}`)

  tunnelUrl = `https://${provisioned.hostname}`
  tunnelError = null
  writeFile(TUNNEL_URL_FILE, tunnelUrl, opts.log)

  opts.log(`tunnel opening (provisioned) url=${tunnelUrl} hostname=${provisioned.hostname}`)
  const proc = Bun.spawn(
    [binary, 'tunnel', 'run', '--token', provisioned.token],
    {
      stderr: 'pipe',
      stdout: 'pipe',
      onExit: (_, code) => {
        opts.log(`cloudflared exited code=${code}`)
        tunnelUrl = null
        tunnelError = 'Tunnel closed. Restart the plugin to reconnect.'
        clearFile(TUNNEL_URL_FILE, opts.log)
        writeFile(TUNNEL_ERROR_FILE, tunnelError, opts.log)
      },
    },
  )

  ;(async () => {
    const decoder = new TextDecoder()
    for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
      opts.log(`cloudflared stderr ${decoder.decode(chunk).trim()}`)
    }
  })()

  const killChild = () => { try { proc.kill() } catch { /* best-effort */ } }
  process.once('exit', killChild)
  process.once('SIGTERM', killChild)
  process.once('SIGINT', killChild)
}
