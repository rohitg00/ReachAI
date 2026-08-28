# ReachAI Backend (iii)

ReachAI backend on the **iii** worker SDK: one worker in five files under [`src/`](src/), and one `worker-compose.yaml` that declares the engine and every worker it runs with.

| File | What it holds |
|---|---|
| `src/index.js` | wiring: imports the modules, binds every topic to its function, `flow-complete`, shutdown |
| `src/worker.js` | the worker registration, state and topic helpers, the `freeStep` / `paidStep` / `route` wrappers, the YouTube, OpenRouter and Razorpay clients, `sendEmail` |
| `src/routes.js` | the 8 HTTP routes |
| `src/free.js` | the free flow: resolve-channel → send-titles-email, its error handler, the titles email template |
| `src/paid.js` | the paid flow: fetch-videos-paid → send-metadata-email-paid, its error handler, the metadata email template |

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
| `/api/jobs/:jobId/retry` | POST | Retry a failed paid job from the first incomplete step |

## Flows

**Free** (`reachai-jobs` state scope): submit → resolve-channel → fetch-videos → fetch-niche → fetch-trending → generate-titles → send-titles-email → done. Errors on any step emit `yt.*.error` → error-handler emails the user.

**Paid** (`reachai-paidjobs`): create-order → verify/webhook → fetch-videos-paid → fetch-niche-paid → fetch-trending-paid → generate-metadata-paid → send-metadata-email-paid → done. A failure is redelivered with exponential backoff up to three attempts, and the third emits `paidUser.*.error` → error-handler-paid, which is what mails the user.

Every topic in both flows is a durable queue on the `queue` worker: delivery survives a restart, so a crash mid-step resumes instead of stranding the job, and a message that keeps failing lands in the DLQ instead of vanishing. Free steps catch their own errors and emit `yt.*.error`, so they are never redelivered.

All steps are idempotent via duplicate-suppression flags (`videosFetched`, `nicheFetched`, `trendVidFetched`, `AiMetadatafetched`, `emailSent`). A webhook + verify double-fire resumes instead of duplicating work.

## Environment variables

See [`env.example`](env.example): `OPENAI_API_KEY` (OpenRouter), `YOUTUBE_API_KEY`, `RESEND_API_KEY`, `MERA_EMAIL`, `FRONTEND_URL`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`. The two sender addresses (`RESEND_FROM_EMAIL` / `RESEND_FROM_SUPPORTEMAIL` before) are now the `from:` of the `notifications` and `support` accounts in [`email/config.yaml`](email/config.yaml); edit them there.

`worker-compose.yaml` hands `.env` to the worker through `env_file`, so the same file serves a local run and the container.

## The project file

[`worker-compose.yaml`](worker-compose.yaml) is the whole deployment, the way `docker-compose.yml` is for containers:

| Container | Source | Role |
|---|---|---|
| `state` | `package://api.workers.iii.dev/state` 0.22.2 | job storage, file-backed at `./data/state_store.db` |
| `http` | `package://api.workers.iii.dev/http` 0.21.4 | the REST surface on port 3111 |
| `queue` | `package://api.workers.iii.dev/queue` 0.21.6 | every topic between the flow steps: durable delivery, retries, DLQ |
| `email` | `package://api.workers.iii.dev/email` 0.1.7 | outbound mail over SMTP; `working_dir: ./email`, so it reads [`email/config.yaml`](email/config.yaml): two accounts, `notifications` and `support`, both on `smtp.resend.com:587` |
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

## Deploy

The image is `node:22-bookworm-slim` plus the pinned iii binary (the glibc build, `III_USE_GLIBC=1`, because the daemon fetches registry packages for its own target and every worker ships a gnu build). It runs the same `iii compose --up` as above, as the unprivileged `node` user, on whatever platform you build it for. Files: `Dockerfile`, `docker-compose.yml`, `worker-compose.yaml`, `.env`.

```bash
# 1. fill in real secrets (never commit .env)
$EDITOR .env

# 2. build & run
docker compose up -d --build

# 3. verify
curl 'http://localhost:3111/status?jobId=none'   # -> 404 = engine + routes live
```

`docker-compose.yml` mounts `.env` read-only into the container, so the same `env_file` line in `worker-compose.yaml` serves both runs and no secret is baked into the image. Only port **3111** (the `http` worker) is published. The engine WebSocket stays on the container's loopback, which is where the five workers reach it; nothing outside the container needs it.

**TLS / domain:** the `http` worker does not terminate TLS. Put a reverse proxy (Caddy/Nginx) in front and route `/api/*`, `/submit` and `/status` to 3111. Point `NEXT_PUBLIC_BACKEND_URL` at your domain and set the Razorpay webhook URL to `https://<your-domain>/api/payment/webhook`.

**Data:** job state, the durable queue and observability data live in the `reachai_data` volume (`./data` inside the container); downloaded worker packages and compose state live in `iii_home`. `docker compose down` keeps both, `down -v` wipes them.

**First boot needs network** to fetch the four registry workers into `iii_home`; later boots reuse the cache.

## Versions

| What | Pin |
|---|---|
| `iii-sdk` (`package.json`) | `0.23.0-rc.5` |
| iii CLI / engine (`Dockerfile`, install command above) | `iii/v0.23.0-rc.5` |
| registry workers (`worker-compose.yaml`) | state 0.22.2, http 0.21.4, queue 0.21.6, email 0.1.7 |

0.23.0 is the release where `iii compose` becomes the way to run a project: engine-managed `workers:` entries in `config.yaml` are rejected (`UNSUPPORTED_CONFIG_WORKERS`) and `iii worker add` is gone, so the previous `config.yaml` no longer exists here. The SDK reads `III_URL` and `III_NAMESPACE` from the daemon, which is why the worker registers in the `reachai` namespace without code changes.

All four registry workers ship binaries for every platform the registry supports, so the image builds natively on amd64 and arm64 alike. When 0.23.0 ships as stable, one tag moves (`III_RELEASE_TAG` in the Dockerfile); no code changes.

Measured on this pin: the four registry workers are `ready` about 2 s after `up`, and `reachai-backend` is `ready` at 1.6 s with 22 functions, 8 HTTP routes and 24 durable subscriptions registered in the `reachai` namespace.

## What the platform provides

Nothing here reimplements what a registry worker already does:

| Concern | Worker |
|---|---|
| HTTP routes | `http`: routes are trigger config, not a server in this code |
| Job state | `state`: `state::get` / `state::set`, three scopes |
| Topics between steps, retries and DLQ | `queue`: `durable:subscriber` triggers and `iii::durable::publish`, `max_retries: 3`, `backoff_ms: 1000` |
| Outbound mail | `email`: `email::send` with an `account`, `to`, `subject`, `html`/`text`, `reply_to`; the `from` address is the account's, set in `email/config.yaml` |

The `email` worker takes its SMTP login from `auth::get_token` (provider key `email::<account>`). The registry has no credentials vault worker at the moment, so `src/worker.js` answers that call itself for `email::*` with the Resend SMTP login (`resend` / `RESEND_API_KEY`). Six lines, and the key never leaves this worker's environment. When a vault worker exists, delete that function and seed it with `auth::set_token` instead. The config lives in its own file rather than a compose `config_override` because email 0.1.7 reads `./config.yaml` from its working directory and does not yet honour the `III_CONFIG` file the daemon writes.

`sendEmail` no longer passes Resend's `Idempotency-Key`; the paid flow's `emailSent` flag is what prevents a duplicate metadata mail on redelivery.

Still hand-rolled: `aiJson()` posts to OpenRouter directly. `llm-router`
plus `provider-openrouter` would take the key, the model catalogue, fallback
and the JSON response format off this file. That one also moves the OpenRouter
key out of `.env` and into the provider worker's configuration, so it is a
deployment change as much as a code change.
