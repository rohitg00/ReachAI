# ReachAI Backend (iii)

ReachAI backend, migrated from **Motia** to the **iii** worker SDK. It is a single-file worker: [`src/index.js`](src/index.js).

## Concept mapping (Motia → iii)

| Motia | iii equivalent |
|---|---|
| `type: 'api'` step (`path`, `method`) | function bound to the engine's `http` trigger type (`{ api_path, http_method }`) |
| `type: 'event'` step (`subscribes`) | plain registered function, wired by topic in the `TOPICS` map |
| `emit({ topic, data })` | `worker.trigger({ function_id, payload, action: TriggerAction.Void() })` (fire-and-forget) |
| `state.get/set(scope, key)` | engine `state::get` / `state::set` (scopes `reachai-jobs`, `reachai-paidjobs`, `reachai-spam`) |
| `logger.*` | `console.*` (captured by engine observability) |
| `infrastructure.queue.maxRetries: 3` (BullMQ) | `paidStep()` wrapper — 3 attempts, counter in job state |
| `razorpay` npm package | direct REST calls to `api.razorpay.com/v1/orders` |
| `motia dev` / workbench | iii console + `worker::add` (local install) |

## HTTP API

| Route | Method | Description |
|---|---|---|
| `/submit` | POST | Start the free-user flow (channel + email) |
| `/status?jobId=` | GET | Poll free-job progress |
| `/api/contact` | POST | Contact form → admin email |
| `/api/payment/create-order` | POST | Create a ₹99 Razorpay order |
| `/api/payment/verify` | POST | Verify Razorpay checkout signature |
| `/api/payment/webhook` | POST | Razorpay webhook (HMAC-verified) |
| `/api/payment/paid-jobs/status?PaidJobId=` | GET | Poll paid-job progress (iii addition) |
| `/api/jobs/:jobId/retry` | POST | Retry a failed paid job from the first incomplete step (implemented in iii; stub in Motia) |

## Flows

**Free** (`reachai-jobs` state scope): submit → resolve-channel → fetch-videos → fetch-niche → fetch-trending → generate-titles → send-titles-email → done. Errors on any step emit `yt.*.error` → error-handler emails the user.

**Paid** (`reachai-paidjobs`): create-order → verify/webhook → fetch-videos-paid → fetch-niche-paid → fetch-trending-paid → generate-metadata-paid → send-metadata-email-paid → done. Each step retries 3× then emits `paidUser.*.error` → error-handler-paid.

All steps are idempotent via duplicate-suppression flags (`videosFetched`, `nicheFetched`, `trendVidFetched`, `AiMetadatafetched`, `emailSent`) — a webhook + verify double-fire resumes instead of duplicating work.

## Environment variables

See [`env.example`](env.example). Same names as the Motia version: `OPENAI_API_KEY` (OpenRouter), `YOUTUBE_API_KEY`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `RESEND_FROM_SUPPORTEMAIL`, `MERA_EMAIL`, `FRONTEND_URL`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`.

## Run

Install as a local iii worker (engine must be running):

```bash
npm install
III_URL=ws://localhost:49134 node src/index.js   # manual
# or install engine-managed (auto-restarts on edits):
iii worker add .
```

HTTP routes are served by the engine's `http` worker (default port **3111**). Route bindings propagate live through the engine — no http restart needed.

## Deploy (replaces Motia Cloud)

The backend ships as a self-contained Docker deployment built on the official `iiidev/iii:latest` image (distroless, non-root). Files: `Dockerfile`, `docker-compose.yml`, `config.yaml`, `.env`.

```bash
# 1. fill in real secrets (never commit .env)
$EDITOR .env

# 2. build & run
docker compose up -d --build

# 3. verify
curl 'http://localhost:3111/status?jobId=none'   # -> 404 = engine + routes live
```

Inside the container: the iii engine + the `http` worker (REST on **3111**) + the `state` worker (job storage) + the `reachai-backend` worker (this code, whose single dependency the engine installs on first boot). The engine WebSocket (49134), stream API (3112), and Prometheus metrics (9464) are also exposed.

**TLS / domain:** the engine does not terminate TLS. Put a reverse proxy (Caddy/Nginx) in front and route `/api/*` → 3111, `/ws` → 49134, `/stream/*` → 3112 — example configs in the [iii deployment docs](https://iii.dev/docs/using-iii/deployment). Point `NEXT_PUBLIC_BACKEND_URL` at your domain and set the Razorpay webhook URL to `https://<your-domain>/api/payment/webhook`.

**Regenerating the assets** (won't overwrite your edits): `iii project generate-docker`.

**Data:** job state persists in the `iii_data` and `iii_config` named volumes — `docker compose down` keeps them, `down -v` wipes them.

## Forward compatibility

iii 0.23 adds **namespace** as a routing dimension and standardises how a
supervisor talks to a worker: `III_URL` for the engine address,
`III_NAMESPACE` for the namespace, `III_CONFIG` for configuration. This worker
already follows that contract — it reads `III_URL` and passes no namespace, so
it lands in the default one and behaves exactly as it does today.

Verified against the 0.23.0-rc.2 SDK on a running engine: 22 functions and all
8 routes register, and a seeded job round-trips through `GET /status`.

`worker-compose.yaml` in this directory targets the **unreleased**
worker-compose format, which replaces the `workers:` list in `config.yaml`
with one file per project. Nothing reads it yet; it is checked in so adopting
`iii compose up` later is a config change, not another migration. Delete it if
you would rather wait for the release.

> Retries are in-process. For crash-safe retries in production, route the steps through the queue worker with `TriggerAction.Enqueue`.
