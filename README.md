# MotionForge Remotion Worker

A separate Node.js service that bundles and renders Remotion projects on
behalf of MotionForge Studio. This is **not** part of the Vite frontend
bundle — Remotion's bundler/renderer and a headless Chromium instance must
run in a real Node.js process, not a browser tab or a static host.

## Why this is separate

Static hosts (Cloudflare Pages, Vercel, Netlify) cannot run long-lived
Node processes or launch Chromium. This worker is meant to run on a VM,
a container platform (Fly.io, Render, Railway, your own Docker host,
etc.) — anywhere that supports long-running Node processes with enough
CPU/RAM for video encoding.

## Security model (read this before deploying)

Uploaded Remotion projects are **untrusted code**. This worker:

- Never executes npm lifecycle scripts (`npm install --ignore-scripts`).
- Checks `package.json` dependencies against an allowlist
  (`src/security.ts`) before installing anything, and rejects anything
  outside it with a clear error — it does not silently strip packages.
- Re-validates every ZIP entry path against traversal (`resolveSafe`)
  even though the frontend already checked this — never trust the client.
- Runs as the non-root `node` user inside the Docker image.
- Should be run with `--cap-drop=ALL`, `--read-only` root filesystem
  (with a `tmpfs` for `/tmp`), and CPU/memory limits — see the comment
  block at the top of `Dockerfile`.
- Holds the Supabase **service role key** — this key must never reach
  the frontend bundle. Only this worker and your Supabase project
  itself should have it.

**Known limitation:** job state is kept in memory (`src/job-manager.ts`).
This is fine for a single worker instance but means job status is lost
on restart and isn't shared across multiple replicas. Swap in a real
queue (e.g. BullMQ + Redis) before scaling horizontally.

## Setup

```bash
cd remotion-worker
cp .env.example .env
# fill in WORKER_AUTH_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
npm install
npm run dev        # ts-node/tsx dev server
# or
npm run build && npm start
```

Then set `VITE_REMOTION_WORKER_URL` in the frontend's `.env.local` to
this worker's public URL, and have the frontend send
`Authorization: Bearer <WORKER_AUTH_TOKEN>` on every request (the
frontend's `render-service.ts` already does this when the env var is
present — see `submitRemotionRenderJob`).

## Docker

```bash
docker build -t motionforge-remotion-worker .
docker run --rm -p 8787:8787 \
  --read-only --tmpfs /tmp:size=2g \
  --cap-drop=ALL --security-opt=no-new-privileges \
  --memory=2g --cpus=2 \
  --env-file .env \
  motionforge-remotion-worker
```

## API

See `API.md` in this directory for the full endpoint reference.

## Unverified in this environment

This worker was type-checked and smoke-tested (`/health` endpoint boots
correctly) in the development sandbox used to build MotionForge Studio,
but an actual end-to-end Remotion render (bundle → render → upload) was
**not** executed here — doing so requires a real Remotion project ZIP,
a headless-Chromium-capable host, and live Supabase credentials, none of
which are available in this build environment. Test it against a real
Remotion project before relying on it in production.
