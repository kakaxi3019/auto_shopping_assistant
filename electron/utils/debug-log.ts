import { appendFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

let logPath: string | null = null

function getLogPath(): string {
  if (!logPath) {
    logPath = join(app.getPath('userData'), 'debug-exclude.log')
  }
  return logPath
}

export function debugLog(tag: string, message: string) {
  const ts = new Date().toISOString()
  const line = `[${ts}] [${tag}] ${message}\n`
  try {
    appendFileSync(getLogPath(), line, 'utf-8')
  } catch { /* ignore */ }
  console.log(`[${tag}] ${message}`)
}
