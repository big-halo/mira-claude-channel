// Observation-only plugin update check (MIR-231).
//
// Fires once at boot. Fetches the upstream marketplace manifest, locates our
// plugin entry, parses its `version`, and compares with the local
// `PLUGIN_VERSION` constant. Never crashes the host on failure — every path
// is wrapped in try/catch and surfaces a structured event via the injected
// shipper plus a one-line log entry.
//
// See docs/auto-update.md for design intent.

import { PLUGIN_VERSION, PLUGIN_MANIFEST_NAME } from './version'

// Raw GitHub URL of this repo's marketplace manifest. The README points users
// at `big-halo/mira-claude-channel` as the marketplace source, so the manifest
// on `main` is the canonical "what would I get if I reinstalled" reference.
const MARKETPLACE_MANIFEST_URL =
  'https://raw.githubusercontent.com/big-halo/mira-claude-channel/main/.claude-plugin/marketplace.json'

const FETCH_TIMEOUT_MS = 8_000

export type AutoUpdateEventKind =
  | 'auto_update_check'
  | 'auto_update_up_to_date'
  | 'auto_update_available'
  | 'auto_update_check_failed'
  | 'version_compare_unknown'

export type AutoUpdateEmit = (
  kind: AutoUpdateEventKind,
  payload: Record<string, unknown>,
) => void

export type AutoUpdateDeps = {
  log: (msg: string, extra?: unknown) => void
  emit: AutoUpdateEmit
  // Override hook for tests; defaults to global fetch.
  fetchImpl?: typeof fetch
  manifestUrl?: string
}

type MarketplacePluginEntry = {
  name?: unknown
  version?: unknown
}

type MarketplaceManifest = {
  plugins?: MarketplacePluginEntry[]
}

type SemverParts = [number, number, number]

// Strict-ish semver parser. Accepts leading "v" and ignores pre-release /
// build metadata for comparison purposes; if the core "X.Y.Z" portion is
// missing or non-numeric the version is treated as unknown.
function parseSemverCore(input: string): SemverParts | null {
  const trimmed = input.trim().replace(/^v/i, '')
  const core = trimmed.split(/[-+]/, 1)[0] ?? ''
  const parts = core.split('.')
  if (parts.length !== 3) return null
  const nums: number[] = []
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null
    const n = Number(p)
    if (!Number.isFinite(n) || n < 0) return null
    nums.push(n)
  }
  return [nums[0]!, nums[1]!, nums[2]!]
}

// Returns -1 if a<b, 0 if equal, 1 if a>b. Lexicographic on the parsed tuple.
function compareSemver(a: SemverParts, b: SemverParts): -1 | 0 | 1 {
  for (let i = 0; i < 3; i++) {
    const av = a[i]!
    const bv = b[i]!
    if (av < bv) return -1
    if (av > bv) return 1
  }
  return 0
}

async function fetchManifest(
  url: string,
  fetchImpl: typeof fetch,
): Promise<MarketplaceManifest> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!res.ok) {
      throw new Error(`http_${res.status}`)
    }
    const body = await res.text()
    return JSON.parse(body) as MarketplaceManifest
  } finally {
    clearTimeout(timer)
  }
}

function findPluginVersion(manifest: MarketplaceManifest): string | null {
  const plugins = Array.isArray(manifest.plugins) ? manifest.plugins : []
  for (const entry of plugins) {
    if (entry && typeof entry === 'object' && entry.name === PLUGIN_MANIFEST_NAME) {
      const v = entry.version
      if (typeof v === 'string' && v.trim()) return v.trim()
      return null
    }
  }
  return null
}

export async function checkForPluginUpdate(deps: AutoUpdateDeps): Promise<void> {
  const { log, emit } = deps
  const fetchImpl = deps.fetchImpl ?? fetch
  const manifestUrl = deps.manifestUrl ?? MARKETPLACE_MANIFEST_URL
  const local = PLUGIN_VERSION

  try {
    log(`auto_update check start local=${local} url=${manifestUrl}`)
    const manifest = await fetchManifest(manifestUrl, fetchImpl)
    const remote = findPluginVersion(manifest)

    if (!remote) {
      const reason = 'remote_version_missing'
      log(`auto_update check FAILED reason=${reason} local=${local}`)
      emit('auto_update_check_failed', { local, remote: null, reason })
      return
    }

    const localParts = parseSemverCore(local)
    const remoteParts = parseSemverCore(remote)

    if (!localParts || !remoteParts) {
      // Fall back to string equality when either side isn't strict semver.
      if (local === remote) {
        log(`auto_update up_to_date (non-semver eq) local=${local} remote=${remote}`)
        emit('auto_update_up_to_date', { local, remote })
      } else {
        log(`auto_update version_compare_unknown local=${local} remote=${remote}`)
        emit('version_compare_unknown', { local, remote })
      }
      return
    }

    const cmp = compareSemver(localParts, remoteParts)
    if (cmp < 0) {
      log(`auto_update AVAILABLE local=${local} remote=${remote}`)
      emit('auto_update_available', { local, remote })
    } else {
      log(`auto_update up_to_date local=${local} remote=${remote}`)
      emit('auto_update_up_to_date', { local, remote })
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    log(`auto_update check FAILED reason=${reason} local=${local}`)
    try {
      emit('auto_update_check_failed', { local, remote: null, reason })
    } catch {
      // shipper is best-effort; never throw from the check.
    }
  }
}
