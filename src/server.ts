import 'dotenv/config'
import express from 'express'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { jobManager } from './job-manager.js'
import { extractProjectZip, validatePackageJson, installDependencies, findEntryFile } from './project-builder.js'
import { renderRemotionComposition } from './remotion-render.js'
import { cleanupWorkDir } from './cleanup.js'

const PORT = Number(process.env.PORT ?? 8787)
const WORKER_AUTH_TOKEN = process.env.WORKER_AUTH_TOKEN
const WORKSPACE_DIR = process.env.WORKSPACE_DIR ?? '/tmp/motionforge-renders'
const MAX_UPLOAD_ZIP_BYTES = Number(process.env.MAX_UPLOAD_ZIP_BYTES ?? 100 * 1024 * 1024)
const MAX_RENDER_SECONDS = Number(process.env.MAX_RENDER_SECONDS ?? 120)
const RENDER_TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_MS ?? 10 * 60 * 1000)

const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    : null

const app = express()
app.use(express.json({ limit: '2mb' }))

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!WORKER_AUTH_TOKEN) {
    res.status(500).json({ error: 'WORKER_AUTH_TOKEN is not configured on this worker.' })
    return
  }
  const header = req.header('authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (token !== WORKER_AUTH_TOKEN) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  next()
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, supabaseConfigured: !!supabase })
})

/**
 * POST /api/render
 * body: { sourceZipUrl: string, compositionId: string, resolution: string, fps: number }
 *
 * `sourceZipUrl` is a short-lived Supabase signed URL the frontend
 * generated for the user's own `motionforge-projects` object — the
 * worker never receives raw Supabase credentials from the client.
 */
app.post('/api/render', requireAuth, async (req, res) => {
  const { sourceZipUrl, compositionId, resolution, fps } = req.body ?? {}
  if (!sourceZipUrl || !compositionId) {
    res.status(400).json({ error: 'sourceZipUrl and compositionId are required.' })
    return
  }

  const job = jobManager.create({ compositionId, resolution: resolution ?? '720p', fps: fps ?? 30 })
  res.status(202).json({ jobId: job.id })

  runRenderJob(job.id, sourceZipUrl, compositionId, resolution ?? '720p').catch((err) => {
    console.error(`[job ${job.id}] unhandled error:`, err)
    jobManager.update(job.id, { status: 'failed', errorMessage: String(err?.message ?? err), completedAt: Date.now() })
  })
})

app.get('/api/render/:id', requireAuth, (req, res) => {
  const job = jobManager.get(req.params.id)
  if (!job) {
    res.status(404).json({ error: 'Job not found.' })
    return
  }
  res.json({
    status: job.status,
    progress: job.progress,
    downloadPath: job.outputUrl,
    error: job.errorMessage,
  })
})

app.post('/api/render/:id/cancel', requireAuth, (req, res) => {
  const ok = jobManager.requestCancel(req.params.id)
  res.json({ ok })
})

app.get('/api/render/:id/download', requireAuth, (req, res) => {
  const job = jobManager.get(req.params.id)
  if (!job || job.status !== 'completed' || !job.outputUrl) {
    res.status(404).json({ error: 'Render output not available.' })
    return
  }
  res.redirect(job.outputUrl)
})

async function runRenderJob(jobId: string, sourceZipUrl: string, compositionId: string, resolution: string) {
  const workDir = path.join(WORKSPACE_DIR, jobId)
  const isCancelled = () => jobManager.get(jobId)?.cancelRequested ?? false

  const timeout = setTimeout(() => {
    jobManager.update(jobId, { status: 'failed', errorMessage: 'Render timed out.', completedAt: Date.now() })
  }, RENDER_TIMEOUT_MS)

  try {
    jobManager.update(jobId, { status: 'analyzing', progress: 2 })
    const zipRes = await fetch(sourceZipUrl)
    if (!zipRes.ok) throw new Error(`Failed to download source project (HTTP ${zipRes.status}).`)
    const arrayBuffer = await zipRes.arrayBuffer()
    if (arrayBuffer.byteLength > MAX_UPLOAD_ZIP_BYTES) {
      throw new Error(`Source archive exceeds the ${MAX_UPLOAD_ZIP_BYTES / 1024 / 1024} MB limit.`)
    }

    jobManager.update(jobId, { status: 'preparing', progress: 8 })
    await extractProjectZip(Buffer.from(arrayBuffer), workDir)

    const depCheck = await validatePackageJson(workDir)
    if (!depCheck.ok) {
      throw new Error(
        `Dependency check failed. Disallowed: ${depCheck.disallowedDependencies.join(', ') || 'none'}. Blocked scripts: ${depCheck.blockedScripts.join(', ') || 'none'}.`
      )
    }
    if (isCancelled()) throw new DOMException('Render cancelled', 'AbortError')

    jobManager.update(jobId, { progress: 15 })
    await installDependencies(workDir, RENDER_TIMEOUT_MS / 2)

    const entryFile = await findEntryFile(workDir)

    jobManager.update(jobId, { status: 'rendering', progress: 20 })
    const outputPath = path.join(workDir, 'output.mp4')
    await renderRemotionComposition({
      workDir,
      entryFile,
      compositionId,
      outputPath,
      resolutionLabel: resolution,
      fps: 30,
      job: jobManager.get(jobId)!,
      onProgress: (p) => jobManager.update(jobId, { progress: p }),
      isCancelled,
    })

    jobManager.update(jobId, { status: 'uploading', progress: 92 })
    const outputUrl = await uploadOutput(jobId, outputPath)

    jobManager.update(jobId, { status: 'completed', progress: 100, outputUrl, completedAt: Date.now() })
  } catch (err) {
    const isAbort = (err as Error)?.name === 'AbortError'
    jobManager.update(jobId, {
      status: isAbort ? 'cancelled' : 'failed',
      errorMessage: isAbort ? null : String((err as Error)?.message ?? err),
      completedAt: Date.now(),
    })
  } finally {
    clearTimeout(timeout)
    await cleanupWorkDir(workDir)
  }
}

async function uploadOutput(jobId: string, outputPath: string): Promise<string | null> {
  if (!supabase) {
    // No Supabase configured — leave output on local disk temporarily so
    // /api/render/:id/download can still redirect to it in dev, but make
    // clear this isn't how production should work.
    console.warn(`[job ${jobId}] SUPABASE not configured — output left at ${outputPath}, will be deleted on cleanup.`)
    return null
  }
  const buffer = await fs.readFile(outputPath)
  const objectPath = `render-outputs/${jobId}.mp4`
  const { error } = await supabase.storage.from('motionforge-exports').upload(objectPath, buffer, {
    contentType: 'video/mp4',
    upsert: true,
  })
  if (error) throw new Error(`Upload to Supabase Storage failed: ${error.message}`)

  const { data, error: signError } = await supabase.storage.from('motionforge-exports').createSignedUrl(objectPath, 3600)
  if (signError) throw new Error(`Failed to create signed download URL: ${signError.message}`)
  return data.signedUrl
}

app.listen(PORT, () => {
  console.log(`MotionForge Remotion worker listening on port ${PORT}`)
  console.log(`Supabase upload: ${supabase ? 'configured' : 'NOT configured (dev mode — outputs stay local and are deleted on cleanup)'}`)
})
