# ReachAI — AI-Powered & Trend-driven YouTube Metadata

ReachAI is an AI-powered backend system that helps YouTube creators improve discoverability by generating trend-aware, SEO-optimized metadata for their videos.

The platform automates the full workflow — from fetching channel data to delivering optimized metadata — using an event-driven backend built as a single **iii** worker. A minimal Next.js frontend is used only for job submission, payments, and status visibility.

Creators can purchase a full metadata bundle for 10 videos at ₹99, with results delivered via email.

---

## 💡 Product Overview

ReachAI is designed for creators who want structured, data-driven metadata without spending hours on manual research.
The system focuses on reliability and clarity by separating each step of the workflow into independent backend events.

---

## 💰 Pricing

| Plan | Details | Price |
|------|--------|-------|
| Free titles | for latest 5 videos two titles for each | **₹0** |
| Full Metadata Bundle | Titles, descriptions, tags, hashtags & reasoning for **10 videos** | **₹99** |

- Payments are handled securely using Razorpay.
- The backend workflow starts only after a verified payment event.

---

## ⚙️ Tech Stack

### Backend
- **iii** — worker SDK: event-driven workflow orchestration (functions + topics), engine-managed state, HTTP triggers ([reachai-backend/README.md](reachai-backend/README.md))
- JavaScript (single-file worker)
- Node.js
- YouTube Data API
- AI (LLM for metadata generation)
- Email service (Resend email)
- Razorpay Webhooks

### Frontend
- Next.js
- Minimal UI for job submission and status updates

---

## 🧱 Architecture Overview

ReachAI uses an event-driven backend architecture where each step is an independent function in the iii worker. Topics wire the steps together:

**Free flow:** `POST /submit` → resolve-channel → fetch-videos → fetch-niche → fetch-trending → generate-titles → send-titles-email ✉️

**Paid flow:** `POST /api/payment/create-order` → Razorpay checkout → verify / webhook → fetch-videos → fetch-niche → fetch-trending → generate-metadata → send-metadata-email ✉️

Job state lives in the engine's state store (scopes `reachai-jobs` / `reachai-paidjobs`); the frontend polls `/status` and `/api/payment/paid-jobs/status`.

See [reachai-backend/README.md](reachai-backend/README.md) for the full API and the Motia → iii migration notes.
