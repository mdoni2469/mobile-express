import { promises as fs } from 'node:fs'

export async function cleanupWorkDir(workDir: string): Promise<void> {
  await fs.rm(workDir, { recursive: true, force: true }).catch((err) => {
    console.error(`[cleanup] failed to remove ${workDir}:`, err)
  })
}
