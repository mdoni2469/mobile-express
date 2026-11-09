import path from 'node:path'

/**
 * This is the AUTHORITATIVE security boundary for Remotion rendering.
 * The frontend's src/security/dependency-policy.ts does an advisory
 * pre-check so users get a compatibility warning before they even
 * submit a job — but since `npm install` and the actual render run
 * here, this file is what actually matters.
 */

export const DEPENDENCY_ALLOWLIST = new Set([
  'remotion',
  '@remotion/cli',
  '@remotion/bundler',
  '@remotion/renderer',
  '@remotion/player',
  '@remotion/media-utils',
  '@remotion/transitions',
  '@remotion/paths',
  '@remotion/shapes',
  '@remotion/noise',
  '@remotion/google-fonts',
  'react',
  'react-dom',
  'zod',
])

export const BLOCKED_LIFECYCLE_SCRIPTS = new Set(['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'gypfile'])

export interface DependencyCheckResult {
  ok: boolean
  disallowedDependencies: string[]
  blockedScripts: string[]
}

export function checkPackageJson(pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> }): DependencyCheckResult {
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  const disallowedDependencies = Object.keys(deps).filter((d) => !DEPENDENCY_ALLOWLIST.has(d))
  const blockedScripts = Object.keys(pkg.scripts ?? {}).filter((s) => BLOCKED_LIFECYCLE_SCRIPTS.has(s))
  return { ok: disallowedDependencies.length === 0, disallowedDependencies, blockedScripts }
}

/**
 * Resolves `relativePath` against `rootDir` and throws if the result
 * would escape `rootDir` — the same zip-slip / path-traversal defense
 * used on the frontend, enforced again here since this is where bytes
 * actually get written to a real filesystem.
 */
export function resolveSafe(rootDir: string, relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
  if (normalized.split('/').includes('..')) {
    throw new Error(`Unsafe path rejected: ${relativePath}`)
  }
  const resolved = path.resolve(rootDir, normalized)
  const resolvedRoot = path.resolve(rootDir)
  if (!resolved.startsWith(resolvedRoot + path.sep) && resolved !== resolvedRoot) {
    throw new Error(`Path traversal rejected: ${relativePath}`)
  }
  return resolved
}

/**
 * Installs dependencies using `npm ci --ignore-scripts` (never plain
 * `npm install`) so lifecycle scripts never execute, regardless of what
 * checkPackageJson already caught — defense in depth.
 */
export const SAFE_INSTALL_ARGS = ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=optional']
