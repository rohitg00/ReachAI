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

The backend ships as a self-contained Docker deployment built on the official `iiidev/iii:0.22.1` image (distroless, non-root), pinned so a new engine release cannot change what a rebuild ships. Files: `Dockerfile`, `docker-compose.yml`, `config.yaml`, `.env`.

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

## Running on the alpha channel

`iii-sdk` is pinned to `0.22.1-alpha.13`, the alpha that carries **namespace
routing** and the supervisor contract (`III_URL`, `III_NAMESPACE`,
`III_CONFIG`). Two reasons to be on it rather than the stable `0.22.1`:

- It is the only channel where `iii compose` exists, so `worker-compose.yaml`
  in this directory actually runs.
- It leaves nothing to change when the work lands in a stable release. The
  worker code already reads the environment a supervisor injects.

Against a stable engine the alpha SDK behaves exactly like the stable one: with
no namespace configured it sends no namespace, so the Docker image below (which
runs the stable engine, since the alpha channel publishes no image) is
unaffected by the pin.

**Running the compose project** needs the alpha engine:

```bash
curl -fsSL https://install.iii.dev/iii/main/install.sh | \
  III_RELEASE_TAG=iii-alpha/v0.22.1-alpha.13 sh

iii compose --namespace reachai          # daemon, from this directory
iii trigger compose::up --namespace reachai file=./worker-compose.yaml
```

Measured on that engine: `pre_start` runs `npm install`, then the worker is
`ready` in about 750ms, registered in the `reachai` namespace. The same code on
`iii-sdk` 0.22.1 (stable) is rejected with `WORKER_IGNORED_NAMESPACE`, because
that SDK predates namespaces and lands in `default` whatever compose injects —
which is exactly why the pin is on the alpha.

**When the stable release ships**, three lines move: `iii-sdk` in
`package.json`, the image tag in `Dockerfile`, and the two package versions in
`worker-compose.yaml`. No code changes.

> Retries are in-process. For crash-safe retries in production, route the steps through the queue worker with `TriggerAction.Enqueue`.
