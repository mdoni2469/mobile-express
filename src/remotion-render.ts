import path from 'node:path'
import { bundle } from '@remotion/bundler'
import { getCompositions, renderMedia, selectComposition } from '@remotion/renderer'
import type { Job } from './job-manager.js'

export interface RenderParams {
  workDir: string
  entryFile: string
  compositionId: string
  outputPath: string
  resolutionLabel: string
  fps: number
  job: Job
  onProgress: (progress: number) => void
  isCancelled: () => boolean
}

const RESOLUTION_SCALE: Record<string, number> = {
  '480p': 480 / 1080,
  '720p': 720 / 1080,
  '1080p': 1,
}

export async function renderRemotionComposition(params: RenderParams): Promise<void> {
  const { workDir, entryFile, compositionId, outputPath, resolutionLabel, job, onProgress, isCancelled } = params

  const bundleLocation = await bundle({
    entryPoint: entryFile,
    outDir: path.join(workDir, '.bundle'),
    onProgress: (p) => onProgress(Math.round(p * 0.2)), // bundling = 0–20%
  })

  if (isCancelled()) throw new DOMException('Render cancelled', 'AbortError')

  const compositions = await getCompositions(bundleLocation)
  if (!compositions.some((c) => c.id === compositionId)) {
    const available = compositions.map((c) => c.id).join(', ')
    throw new Error(`Composition "${compositionId}" not found. Available: ${available || 'none'}`)
  }

  const composition = await selectComposition({
    serveUrl: bundleLocation,
    id: compositionId,
  })

  const scale = RESOLUTION_SCALE[resolutionLabel] ?? 1

  await renderMedia({
    composition: {
      ...composition,
      width: Math.round(composition.width * scale),
      height: Math.round(composition.height * scale),
    },
    serveUrl: bundleLocation,
    codec: 'h264',
    outputLocation: outputPath,
    onProgress: ({ progress }) => {
      if (isCancelled()) throw new DOMException('Render cancelled', 'AbortError')
      onProgress(20 + Math.round(progress * 70)) // rendering = 20–90%
    },
  })
}
