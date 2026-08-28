import { registerWorker, TriggerAction } from 'iii-sdk'

const worker = registerWorker(process.env.III_URL ?? 'ws://127.0.0.1:49134', {
  workerName: 'reachai-backend',
  workerDescription:
    'ReachAI backend: YouTube title/metadata optimization flows (free + paid) with email delivery and Razorpay payments.',
  invocationTimeoutMs: 180000,
})

const SCOPES = { jobs: 'reachai-jobs', paidJobs: 'reachai-paidjobs', spam: 'reachai-spam' }
const sGet = async (scope, key) =>
  (await worker.trigger({ function_id: 'state::get', payload: { scope, key }, timeoutMs: 10000 }).catch(() => null)) ?? null
const sSet = (scope, key, value) =>
  worker.trigger({ function_id: 'state::set', payload: { scope, key, value }, timeoutMs: 10000 })

const SUBSCRIPTIONS = {
  'reachai-backend::resolve-channel': ['yt.submit'],
  'reachai-backend::fetch-videos': ['yt.channel.resolved'],
  'reachai-backend::fetch-niche': ['yt.videos.fetched'],
  'reachai-backend::fetch-trending': ['yt.niche.fetched'],
  'reachai-backend::generate-titles': ['yt.trendingVideos.fetched'],
  'reachai-backend::send-titles-email': ['yt.AI-Title.fetched'],
  'reachai-backend::error-handler': [
    'yt.channel.error',
    'yt.videos.error',
    'yt.niche.error',
    'yt.trendingVideos.error',
    'yt.AI-Title.error',
    'yt.titles.Email-Send.error',
  ],
  'reachai-backend::flow-complete': ['yt.titles.Email-Send', 'PaidUser.Email-Send.success'],
  'reachai-backend::error-handler-paid': [
    'paidUser.videosfetched.error',
    'paidUser.Nichefetched.error',
    'paidUser.trendVid.error',
    'paidUser.AImetadata.error',
    'PaidUser.Email-Send.error',
  ],
  'reachai-backend::fetch-videos-paid': ['paidUser.payment.success'],
  'reachai-backend::fetch-niche-paid': ['paidUser.videosfetched.success'],
  'reachai-backend::fetch-trending-paid': ['paidUser.Nichefetched.success'],
  'reachai-backend::generate-metadata-paid': ['paidUser.trendVid.success'],
  'reachai-backend::send-metadata-email-paid': ['paidUser.AImetadata.success'],
}
const PAID_ATTEMPTS = 3

const emit = (topic, data) =>
  worker.trigger({
    function_id: 'iii::durable::publish',
    payload: { topic, data },
    action: TriggerAction.Void(),
  })

const youtubeSearch = async (params, apiKey) => {
  const qs = new URLSearchParams({ ...params, key: apiKey }).toString()
  const res = await fetch(`https://www.googleapis.com/youtube/v3/search?${qs}`)
  if (!res.ok) throw new Error(`YouTube API failed with status ${res.status}`)
  return res.json()
}

const aiJson = async ({ system, user, temperature = 0.7, maxTokens }) => {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OpenAI/OpenRouter api key not configured')
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'openai/gpt-4o-mini',
      temperature,
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`OpenAI API error: ${err.error?.message || res.status}`)
  }
  const result = await res.json()
  return JSON.parse(result.choices?.[0]?.message?.content || '{}')
}

const sendEmail = ({ account = 'notifications', to, subject, html, text, replyTo }) =>
  worker.trigger({
    function_id: 'email::send',
    payload: {
      account,
      to: [to],
      subject,
      ...(html ? { html } : {}),
      ...(text ? { text } : {}),
      ...(replyTo ? { reply_to: replyTo } : {}),
    },
    timeoutMs: 30000,
  })

const razorpayCreateOrder = async ({ amountPaise, currency = 'INR', receipt, notes }) => {
  const id = process.env.RAZORPAY_KEY_ID
  const secret = process.env.RAZORPAY_KEY_SECRET
  if (!id || !secret) throw new Error('Razorpay keys not configured')
  const res = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
    },
    body: JSON.stringify({ amount: amountPaise, currency, receipt, notes }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`Razorpay order failed: ${err.error?.description || res.status}`)
  }
  return res.json()
}

const esc = (s = '') => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const ytId = (u) => (String(u || '').match(/[?&]v=([\w-]{6,})/) || [])[1] || null
const thumbFor = (u, fallback, q = 'sddefault') =>
  ytId(u) ? `https://i.ytimg.com/vi/${ytId(u)}/${q}.jpg` : esc(fallback || '')

const FREE_ERROR_TOPICS = {
  'reachai-backend::resolve-channel': 'yt.channel.error',
  'reachai-backend::fetch-videos': 'yt.videos.error',
  'reachai-backend::fetch-niche': 'yt.niche.error',
  'reachai-backend::fetch-trending': 'yt.trendingVideos.error',
  'reachai-backend::generate-titles': 'yt.AI-Title.error',
  'reachai-backend::send-titles-email': 'yt.titles.Email-Send.error',
}
const freeStep = (id, description, run) =>
  worker.registerFunction(
    id,
    async (data) => {
      const jobId = data.jobId
      const email = data.email
      try {
        await run(data, jobId, email)
      } catch (error) {
        console.error(`[${id}]`, error.message)
        if (!jobId || !email) return console.error('missing jobId/email, cannot notify')
        const job = (await sGet(SCOPES.jobs, jobId)) || {}
        await sSet(SCOPES.jobs, jobId, { ...job, status: 'failed', error: error.message })
        await emit(FREE_ERROR_TOPICS[id], { jobId, email, error: `${error.message}. Please try again` })
      }
    },
    { description },
  )

const paidStep = (id, description, retryKey, errorTopic, run) =>
  worker.registerFunction(
    id,
    async (data) => {
      const PaidJobId = data.PaidJobId
      try {
        await run(data, PaidJobId)
      } catch (error) {
        console.error(`[${id}]`, error.message, { PaidJobId })
        const job = (await sGet(SCOPES.paidJobs, PaidJobId).catch(() => null)) || {}
        const attempt = ((job.retry ?? {})[retryKey] ?? 0) + 1
        await sSet(SCOPES.paidJobs, PaidJobId, {
          ...job,
          status: 'retrying',
          lastError: error.message,
          retry: { ...(job.retry ?? {}), [retryKey]: attempt },
        }).catch(() => {})
        if (attempt >= PAID_ATTEMPTS) {
          await emit(errorTopic, { PaidJobId, email: data.email, error: error.message, attemptCount: attempt })
          return
        }
        throw error
      }
    },
    { description },
  )

const route = (fnId, api_path, http_method, handler) => {
  worker.registerFunction(fnId, handler, {
    description: `HTTP ${http_method} ${api_path}`,
  })
  worker.registerTrigger({
    type: 'http',
    function_id: fnId,
    config: { api_path, http_method },
  })
}

export { worker, SCOPES, sGet, sSet, SUBSCRIPTIONS, PAID_ATTEMPTS, emit, youtubeSearch, aiJson, sendEmail, razorpayCreateOrder, esc, thumbFor, freeStep, paidStep, route }
