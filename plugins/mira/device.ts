import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { hostname } from 'os'
import { randomUUID } from 'crypto'

const DEVICE_FILE = `${process.env.HOME}/.mira-mcp/device.json`

type DeviceInfo = { device_id: string; device_label: string }

export function getOrCreateDevice(): DeviceInfo {
  if (existsSync(DEVICE_FILE)) {
    try {
      return JSON.parse(readFileSync(DEVICE_FILE, 'utf8')) as DeviceInfo
    } catch { /* fall through to regenerate */ }
  }
  const info: DeviceInfo = { device_id: randomUUID(), device_label: hostname() }
  mkdirSync(`${process.env.HOME}/.mira-mcp`, { recursive: true })
  writeFileSync(DEVICE_FILE, JSON.stringify(info, null, 2), { mode: 0o600 })
  return info
}