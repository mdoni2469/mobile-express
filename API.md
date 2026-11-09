# Remotion Worker API

All endpoints except `/health` require `Authorization: Bearer <WORKER_AUTH_TOKEN>`.

## `GET /health`

No auth required. Returns worker liveness and whether Supabase upload is configured.

```json
{ "ok": true, "supabaseConfigured": true }
```

## `POST /api/render`

Starts a render job and returns immediately with a job id (the actual
work happens asynchronously).

Request body:

```json
{
  "sourceZipUrl": "https://<project>.supabase.co/storage/v1/object/sign/...",
  "compositionId": "MyComposition",
  "resolution": "720p",
  "fps": 30
}
```

- `sourceZipUrl` — a short-lived **signed URL** to the project ZIP in
  the `motionforge-projects` Supabase bucket. The frontend generates
  this with the authenticated user's own session — the worker never
  receives a service-role-level Supabase connection from the client.
- `compositionId` — which `<Composition id="...">` to render, as shown
  in the frontend's compatibility report.
- `resolution` — `480p`, `720p`, or `1080p`. Scales the composition's
  declared width/height proportionally.

Response (`202 Accepted`):

```json
{ "jobId": "aB3dEfGhIjKl" }
```

## `GET /api/render/:id`

Poll for job status.

```json
{
  "status": "rendering",
  "progress": 42,
  "downloadPath": null,
  "error": null
}
```

`status` is one of: `queued`, `analyzing`, `preparing`, `rendering`,
`encoding`, `uploading`, `completed`, `failed`, `cancelled` — matching
the statuses in the `render_jobs` Supabase table so the frontend can
mirror worker state 1:1.

When `status` is `completed`, `downloadPath` is a signed URL to the
rendered MP4 in the `motionforge-exports` bucket (valid for 1 hour by
default — generate a fresh one via `/api/render/:id/download` if it
expires).

## `POST /api/render/:id/cancel`

Requests cancellation. The render checks this flag between bundling,
composition selection, and each render-progress tick, and stops as soon
as it's next checked — it is not always instantaneous (an in-flight
Chromium frame render can't be interrupted mid-frame).

```json
{ "ok": true }
```

## `GET /api/render/:id/download`

Redirects (`302`) to a freshly-signed download URL for a completed job's
output. Returns `404` if the job isn't `completed` yet.
