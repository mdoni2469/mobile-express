import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import JSZip from 'jszip'
import { checkPackageJson, resolveSafe, SAFE_INSTALL_ARGS } from './security.js'

export interface PreparedProject {
  workDir: string
  entryFile: string
}

/**
 * Extracts a validated ZIP buffer into an isolated per-job directory,
 * re-checking path safety during extraction (defense in depth — the
 * frontend already validated this archive, but we never trust a client
 * to have enforced that correctly).
 */
export async function extractProjectZip(zipBuffer: Buffer, workDir: string): Promise<void> {
  const zip = await JSZip.loadAsync(zipBuffer)
  await fs.mkdir(workDir, { recursive: true })

  for (const [entryName, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue
    const destPath = resolveSafe(workDir, entryName)
    await fs.mkdir(path.dirname(destPath), { recursive: true })
    const content = await entry.async('nodebuffer')
    await fs.writeFile(destPath, content)
  }
}

export async function validatePackageJson(workDir: string): Promise<{ ok: boolean; disallowedDependencies: string[]; blockedScripts: string[] }> {
  const pkgPath = path.join(workDir, 'package.json')
  const raw = await fs.readFile(pkgPath, 'utf-8').catch(() => null)
  if (!raw) {
    return { ok: false, disallowedDependencies: [], blockedScripts: [] }
  }
  const pkg = JSON.parse(raw)
  return checkPackageJson(pkg)
}

/**
 * Installs dependencies with lifecycle scripts disabled, as a non-root
 * user (the Docker image runs the whole process as `node`, never root —
 * see Dockerfile), with no access to this process's environment secrets
 * beyond what npm itself needs.
 */
export function installDependencies(workDir: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', SAFE_INSTALL_ARGS, {
      cwd: workDir,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, npm_config_cache: '/tmp/.npm-cache' },
      timeout: timeoutMs,
    })
    let stderr = ''
    child.stderr?.on('data', (d) => (stderr += d.toString()))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`npm install failed (exit ${code}): ${stderr.slice(-2000)}`))
    })
  })
}

export async function findEntryFile(workDir: string): Promise<string> {
  const candidates = ['src/index.ts', 'src/index.tsx', 'src/Root.tsx', 'remotion/index.ts', 'index.ts']
  for (const candidate of candidates) {
    const full = path.join(workDir, candidate)
    if (
      await fs
        .access(full)
        .then(() => true)
        .catch(() => false)
    ) {
      return full
    }
  }
  throw new Error('No Remotion entry point found (expected src/index.ts, src/Root.tsx, or similar).')
}
