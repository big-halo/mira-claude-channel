import { homedir } from 'os'
import { join } from 'path'

export function miraHomeDir(): string {
  const override = process.env.MIRA_HOME?.trim()
  if (override) return override

  if (process.platform === 'win32') {
    const profile = process.env.USERPROFILE?.trim() ||
      process.env.HOME?.trim() ||
      homedir()
    return join(profile, '.mira-mcp')
  }

  return process.env.HOME?.trim()
    ? join(process.env.HOME, '.mira-mcp')
    : join(homedir(), '.mira-mcp')
}

export function miraPath(...parts: string[]): string {
  return join(miraHomeDir(), ...parts)
}
