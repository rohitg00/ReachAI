# ReachAI Backend (iii)

ReachAI backend, migrated from **Motia** to the **iii** worker SDK. It is a single-file worker: [`src/index.js`](src/index.js).

## Concept mapping (Motia → iii)

| Motia | iii equivalent |
|---|---|
| `type: 'api'` step (`path`, `method`) | function bound to the `http` worker's `http` trigger type (`{ api_path, http_method }`) |
| `type: 'event'` step (`subscribes`) | function bound to the `pubsub` worker's `subscribe` trigger on the same topic |
| `emit({ topic, data })` | the `pubsub` worker's `publish` function (fire-and-forget fan-out) |
| `state.get/set(scope, key)` | `state::get` / `state::set` on the `state` worker (scopes `reachai-jobs`, `reachai-paidjobs`, `reachai-spam`) |
| `logger.*` | `console.*` (captured by engine observability) |
| `infrastructure.queue.maxRetries: 3` (BullMQ) | the `queue` worker's `durable:subscriber`: 3 attempts, exponential backoff, DLQ |
| `razorpay` npm package | direct REST calls to `api.razorpay.com/v1/orders` |
| `motia dev` / workbench | `iii compose` (`worker-compose.yaml` declares the engine and every worker) |

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

**Paid** (`reachai-paidjobs`): create-order → verify/webhook → fetch-videos-paid → fetch-niche-paid → fetch-trending-paid → generate-metadata-paid → send-metadata-email-paid → done. These steps run on the `queue` worker: a failure is redelivered with exponential backoff up to three attempts, and the third emits `paidUser.*.error` → error-handler-paid, which is what mails the user. Delivery survives a restart, so a crash mid-step resumes instead of stranding the job.

All steps are idempotent via duplicate-suppression flags (`videosFetched`, `nicheFetched`, `trendVidFetched`, `AiMetadatafetched`, `emailSent`). A webhook + verify double-fire resumes instead of duplicating work.

## Environment variables

See [`env.example`](env.example). Same names as the Motia version: `OPENAI_API_KEY` (OpenRouter), `YOUTUBE_API_KEY`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `RESEND_FROM_SUPPORTEMAIL`, `MERA_EMAIL`, `FRONTEND_URL`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`.

`worker-compose.yaml` hands `.env` to the worker through `env_file`, so the same file serves a local run and the container.

## The project file

[`worker-compose.yaml`](worker-compose.yaml) is the whole deployment, the way `docker-compose.yml` is for containers:

| Container | Source | Role |
|---|---|---|
| `state` | `package://api.workers.iii.dev/state` 0.22.2 | job storage, file-backed at `./data/state_store.db` |
| `http` | `package://api.workers.iii.dev/http` 0.21.4 | the REST surface on port 3111 |
| `pubsub` | `package://api.workers.iii.dev/pubsub` 0.21.3-rc.2 | topic fan-out between the flow steps |
| `queue` | `package://api.workers.iii.dev/queue` 0.21.6 | durable retries and DLQ for the paid flow |
| `reachai-backend` | `path://.` | this code; `start_after` the four above, `npm install` then `node src/index.js` |

The `engine:` block makes `iii compose --up` start the engine itself (on `ws://127.0.0.1:49134`) and stop it with the project. Registry packages are downloaded on the first `up` and cached under `~/.iii/compose/packages`. Generated worker configs land in `./config/`, runtime data in `./data/`; both are ignored by git.

## Run

Needs Node 22 and the iii CLI:

```bash
curl -fsSL https://install.iii.dev/iii/main/install.sh | III_RELEASE_TAG=iii/v0.23.0-rc.5 sh
cp env.example .env
iii compose --namespace reachai --up --file worker-compose.yaml
curl 'http://localhost:3111/status?jobId=none'   # 404 = engine + routes live
```

The daemon stays in the foreground; Ctrl-C (SIGINT) stops the worker, the four registry workers and the engine in order. From another shell:

```bash
iii trigger compose::status --namespace reachai file=worker-compose.yaml
iii trigger compose::restart --namespace reachai file=worker-compose.yaml container=reachai-backend
```

To attach to an engine you already run instead of a managed one, add `--engine ws://host:49134`; that overrides the `engine.url` in the file.

Note for macOS: `pubsub` 0.21.3-rc.2 currently ships a `x86_64-unknown-linux-gnu` binary only, so on a Mac the project starts once you point that container at a locally built `pubsub` (`path://` plus `scripts.run`). Linux hosts and the container below need no change.

## Deploy (replaces Motia Cloud)

The image is `node:22-bookworm-slim` plus the pinned iii binary (the glibc build, `III_USE_GLIBC=1`: the daemon fetches registry packages for its own target, and the registry ships `x86_64-unknown-linux-gnu`, not musl, for pubsub). It runs the same `iii compose --up` as above, as the unprivileged `node` user. Files: `Dockerfile`, `docker-compose.yml`, `worker-compose.yaml`, `.env`.

```bash
# 1. fill in real secrets (never commit .env)
$EDITOR .env

# 2. build & run
docker compose up -d --build

# 3. verify
curl 'http://localhost:3111/status?jobId=none'   # -> 404 = engine + routes live
```

`docker-compose.yml` mounts `.env` read-only into the container, so the same `env_file` line in `worker-compose.yaml` serves both runs and no secret is baked into the image. Only port **3111** (the `http` worker) is published. The engine WebSocket stays on the container's loopback, which is where the five workers reach it; nothing outside the container needs it. The image is built for `linux/amd64` (`platform:` in `docker-compose.yml`) because that is the platform the registry ships every pinned worker for.

**TLS / domain:** the `http` worker does not terminate TLS. Put a reverse proxy (Caddy/Nginx) in front and route `/api/*`, `/submit` and `/status` to 3111. Point `NEXT_PUBLIC_BACKEND_URL` at your domain and set the Razorpay webhook URL to `https://<your-domain>/api/payment/webhook`.

**Data:** job state, the durable queue and observability data live in the `reachai_data` volume (`./data` inside the container); downloaded worker packages and compose state live in `iii_home`. `docker compose down` keeps both, `down -v` wipes them.

**First boot needs network** to fetch the four registry workers into `iii_home`; later boots reuse the cache.

## Versions

| What | Pin |
|---|---|
| `iii-sdk` (`package.json`) | `0.23.0-rc.5` |
| iii CLI / engine (`Dockerfile`, install command above) | `iii/v0.23.0-rc.5` |
| registry workers (`worker-compose.yaml`) | state 0.22.2, http 0.21.4, pubsub 0.21.3-rc.2, queue 0.21.6 |

0.23.0 is the release where `iii compose` becomes the way to run a project: engine-managed `workers:` entries in `config.yaml` are rejected (`UNSUPPORTED_CONFIG_WORKERS`) and `iii worker add` is gone, so the previous `config.yaml` no longer exists here. The SDK reads `III_URL` and `III_NAMESPACE` from the daemon, which is why the worker registers in the `reachai` namespace without code changes.

`pubsub` is on its `0.21.3-rc.2` pre-release because `0.21.2` predates namespace routing: the daemon rejects it with `WORKER_IGNORED_NAMESPACE`. When 0.23.0 and pubsub 0.21.3 ship as stable, the two tags move (`III_RELEASE_TAG` in the Dockerfile, the pubsub `version:`); no code changes.

Measured on this pin: the four registry workers are `ready` 1.4 s after `up`, and `reachai-backend` is `ready` at 1.6 s with 22 functions, 8 HTTP routes, 19 pubsub subscriptions and 5 durable subscribers registered in the `reachai` namespace.

## What the platform provides

Nothing here reimplements what a registry worker already does:

| Concern | Worker |
|---|---|
| HTTP routes | `http`: routes are trigger config, not a server in this code |
| Job state | `state`: `state::get` / `state::set`, three scopes |
| Topic fan-out between steps | `pubsub`: `subscribe` triggers and the `publish` function |
| Retries and DLQ on the paid flow | `queue`: `durable:subscriber`, `max_retries: 3`, `backoff_ms: 1000` |

One is still hand-rolled: `aiJson()` posts to OpenRouter directly. `llm-router`
plus `provider-openrouter` would take the key, the model catalogue, fallback
and the JSON response format off this file. That one also moves the OpenRouter
key out of `.env` and into the provider worker's configuration, so it is a
deployment change as much as a code change.
