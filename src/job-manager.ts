import { nanoid } from 'nanoid'

export type JobStatus = 'queued' | 'analyzing' | 'preparing' | 'rendering' | 'encoding' | 'uploading' | 'completed' | 'failed' | 'cancelled'

export interface Job {
  id: string
  status: JobStatus
  progress: number
  createdAt: number
  completedAt: number | null
  errorMessage: string | null
  outputUrl: string | null
  cancelRequested: boolean
  compositionId: string
  resolution: string
  fps: number
}

/**
 * In-memory job registry. This is intentionally simple for the MVP — a
 * single-process worker with jobs tracked in memory. Swap for a real
 * queue (BullMQ/Redis, etc.) before running more than one worker
 * instance, since job state would otherwise not be shared across
 * processes. Documented as a known limitation in the worker README.
 */
class JobManager {
  private jobs = new Map<string, Job>()

  create(input: { compositionId: string; resolution: string; fps: number }): Job {
    const job: Job = {
      id: nanoid(12),
      status: 'queued',
      progress: 0,
      createdAt: Date.now(),
      completedAt: null,
      errorMessage: null,
      outputUrl: null,
      cancelRequested: false,
      ...input,
    }
    this.jobs.set(job.id, job)
    return job
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id)
  }

  update(id: string, patch: Partial<Job>): Job | undefined {
    const job = this.jobs.get(id)
    if (!job) return undefined
    Object.assign(job, patch)
    return job
  }

  requestCancel(id: string): boolean {
    const job = this.jobs.get(id)
    if (!job) return false
    job.cancelRequested = true
    return true
  }

  /** Periodic sweep so old job records don't leak memory forever. */
  pruneOlderThan(ms: number) {
    const cutoff = Date.now() - ms
    for (const [id, job] of this.jobs) {
      if (job.createdAt < cutoff && (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled')) {
        this.jobs.delete(id)
      }
    }
  }
}

export const jobManager = new JobManager()
setInterval(() => jobManager.pruneOlderThan(24 * 60 * 60 * 1000), 60 * 60 * 1000)
