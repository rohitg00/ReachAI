import { registerWorker, TriggerAction } from 'iii-sdk'
import crypto from 'node:crypto'

const worker = registerWorker(process.env.III_URL ?? 'ws://127.0.0.1:49134', {
  workerName: 'reachai-backend',
  workerDescription:
    'ReachAI backend: YouTube title/metadata optimization flows (free + paid) with Resend emails and Razorpay payments. Migrated from Motia.',
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

const sendEmail = async ({ from, to, subject, html, text, idempotencyKey }) => {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) throw new Error('Resend api key not configured')
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: JSON.stringify({ from, to: [to], subject, ...(html ? { html } : {}), ...(text ? { text } : {}) }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`Resend API error: ${err.error?.message || res.status}`)
  }
  return res.json()
}

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

route('reachai-backend::submit', '/submit', 'POST', async (req) => {
  try {
    const { channel, email } = req.body ?? {}
    if (!channel || !email) {
      return { status_code: 400, body: { error: 'Missing required fields : channel , email' } }
    }
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return { status_code: 400, body: { error: 'Invalid email format' } }
    }

    const SPAM_WINDOW = 3 * 60 * 1000
    const lastSubKey = `lastSub:${email}`
    const lastSub = await sGet(SCOPES.spam, lastSubKey)
    if (lastSub && Date.now() - lastSub.time < SPAM_WINDOW) {
      return {
        status_code: 429,
        body: {
          error: 'Please wait before submitting again',
          waitSeconds: Math.ceil((SPAM_WINDOW - (Date.now() - lastSub.time)) / 1000),
        },
      }
    }
    await sSet(SCOPES.spam, lastSubKey, { time: Date.now() })

    const jobId = crypto.randomUUID()
    await sSet(SCOPES.jobs, jobId, {
      jobId,
      channel,
      email,
      region: 'IN',
      status: 'queued',
      CreatedAt: new Date().toISOString(),
    })
    console.log('Job created', { jobId, email, channel })
    await emit('yt.submit', { jobId, channel, email })

    return {
      status_code: 200,
      body: {
        success: true,
        jobId,
        message:
          'Your request has been queued. You will get an email soon with improved suggestions for your youtube videos',
      },
    }
  } catch (error) {
    console.error('Error in submission handler', { error: error.message })
    return { status_code: 500, body: { error: 'Internal server error' } }
  }
})

route('reachai-backend::get-status', '/status', 'GET', async (req) => {
  const jobId = req.query_params?.jobId
  if (!jobId) return { status_code: 400, body: { error: 'Missing jobId' } }
  const job = await sGet(SCOPES.jobs, jobId)
  if (!job) return { status_code: 404, body: { error: 'Missing job data' } }
  return { status_code: 200, body: { status: job.status } }
})

route('reachai-backend::contact', '/api/contact', 'POST', async (req) => {
  try {
    const { name = '', email = '', message = '' } = req.body ?? {}
    if (!name.trim() || !email.trim() || !message.trim()) {
      return { status_code: 400, body: { success: false, error: 'All fields are required' } }
    }
    const apiKey = process.env.RESEND_API_KEY
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        from: process.env.RESEND_FROM_SUPPORTEMAIL,
        to: process.env.MERA_EMAIL,
        reply_to: email,
        subject: 'New Contact Form Message',
        html: `<h3>New Support Message</h3><p><strong>Name:</strong> ${name}</p><p><strong>Email:</strong> ${email}</p><p><strong>Message:</strong></p><p>${message}</p>`,
      }),
    })
    if (!res.ok) return { status_code: 500, body: { success: false, error: 'Failed to send email' } }
    return { status_code: 200, body: { success: true } }
  } catch (err) {
    console.error('Contact form error:', err)
    return { status_code: 500, body: { success: false, error: 'Server error' } }
  }
})

route('reachai-backend::get-paid-status', '/api/payment/paid-jobs/status', 'GET', async (req) => {
  const PaidJobId = req.query_params?.PaidJobId
  if (!PaidJobId) return { status_code: 400, body: { error: 'Missing PaidJobId' } }
  const job = await sGet(SCOPES.paidJobs, PaidJobId)
  if (!job) return { status_code: 404, body: { error: 'Job not found' } }
  return { status_code: 200, body: { status: job.status } }
})

route('reachai-backend::create-order', '/api/payment/create-order', 'POST', async (req) => {
  try {
    if (!req.body) return { status_code: 400, body: { error: 'Bad request' } }
    const { channelId, email } = req.body
    if (!channelId || !email) {
      return { status_code: 400, body: { error: 'Missing required fields : channelId , email' } }
    }

    const PaidJobId = crypto.randomUUID()
    const receipt = `reachai_${channelId}_${Date.now()}`.slice(0, 35)
    const order = await razorpayCreateOrder({
      amountPaise: 99 * 100,
      currency: 'INR',
      receipt,
      notes: { email, channelId, service: 'youtube_metadata_full', PaidJobId },
    })
    if (!order || !order.id) {
      return {
        status_code: 400,
        body: { success: false, error: 'Order creation failed: No order ID returned', debug: order },
      }
    }

    await sSet(SCOPES.paidJobs, PaidJobId, {
      orderId: order.id,
      receipt,
      amount: 99,
      PaidJobId,
      channelId,
      email,
      status: 'order_created',
      CreatedAt: new Date().toISOString(),
    })

    return {
      status_code: 200,
      body: {
        success: true,
        orderId: order.id,
        amount: order.amount,
        currency: order.currency,
        keyId: process.env.RAZORPAY_KEY_ID,
        PaidJobId,
      },
    }
  } catch (error) {
    console.error('PaidUser-CreateOrder error', { error: error.message })
    return { status_code: 500, body: { error: 'Internal server error' } }
  }
})

route('reachai-backend::verify-payment', '/api/payment/verify', 'POST', async (req) => {
  try {
    if (!req.body) return { status_code: 400, body: { error: 'Bad request' } }
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, PaidJobId } = req.body
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !PaidJobId) {
      return { status_code: 400, body: { error: 'Missing required fields' } }
    }

    const expectedSign = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex')
    const isValid = expectedSign === razorpay_signature

    const job = (await sGet(SCOPES.paidJobs, PaidJobId)) || {}
    await sSet(SCOPES.paidJobs, PaidJobId, {
      ...job,
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      status: isValid ? 'payment_verified' : 'payment_failed',
      verifiedAt: new Date().toISOString(),
    })

    if (!isValid) {
      return { status_code: 400, body: { success: false, error: 'Invalid payment signature' } }
    }

    await emit('paidUser.payment.success', { PaidJobId })
    return { status_code: 200, body: { success: true } }
  } catch (error) {
    console.error('Verify payment error', { msg: error.message })
    return { status_code: 500, body: { error: 'Internal server error' } }
  }
})

route('reachai-backend::webhook', '/api/payment/webhook', 'POST', async (req) => {
  try {
    const signature = req.headers?.['x-razorpay-signature']
    if (!signature) return { status_code: 400, body: { error: 'Missing signature' } }

    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
      .update(JSON.stringify(req.body))
      .digest('hex')
    if (expectedSignature !== signature) {
      return { status_code: 400, body: { error: 'Invalid webhook signature' } }
    }

    const event = req.body.event
    const payment = req.body.payload?.payment?.entity
    if (!payment) return { status_code: 400, body: { error: 'Invalid payload' } }

    const PaidJobId = payment.notes?.PaidJobId
    if (!PaidJobId) {
      return { status_code: 200, body: { success: true, message: 'PaidJobId missing in notes, skipping.' } }
    }
    if (event !== 'payment.captured') return { status_code: 200, body: { success: true } }

    const job = await sGet(SCOPES.paidJobs, PaidJobId)
    if (!job) return { status_code: 200, body: { success: true, message: 'Job not found, skipping.' } }
    if (job.status === 'payment_verified') return { status_code: 200, body: { success: true } }

    await sSet(SCOPES.paidJobs, PaidJobId, {
      ...job,
      razorpay_order_id: payment.order_id,
      razorpay_payment_id: payment.id,
      status: 'payment_verified',
      verifiedAt: new Date().toISOString(),
      verifiedByWebhook: true,
    })
    await emit('paidUser.payment.success', { PaidJobId })
    return { status_code: 200, body: { success: true } }
  } catch (error) {
    console.error('Webhook error', { message: error.message })
    return { status_code: 500, body: { error: 'Server error in webhook' } }
  }
})

route('reachai-backend::manual-retry', '/api/jobs/:jobId/retry', 'POST', async (req) => {
  const PaidJobId = req.path_params?.jobId
  if (!PaidJobId) return { status_code: 400, body: { error: 'Missing jobId' } }
  const job = await sGet(SCOPES.paidJobs, PaidJobId)
  if (!job) return { status_code: 404, body: { error: 'Job not found' } }

  await sSet(SCOPES.paidJobs, PaidJobId, {
    ...job,
    status: 'retrying',
    retry: {},
    retriedAt: new Date().toISOString(),
  })

  if (!job.videosFetched) {
    await emit('paidUser.payment.success', { PaidJobId })
  } else if (!job.nicheFetched) {
    await emit('paidUser.videosfetched.success', {
      PaidJobId,
      email: job.email,
      channelId: job.channelId,
      videos: job.videos,
    })
  } else if (!job.trendVidFetched) {
    await emit('paidUser.Nichefetched.success', {
      PaidJobId,
      email: job.email,
      channelId: job.channelId,
      channelName: job.channelName,
      niches: job.niches,
      reason: job.reason,
    })
  } else {
    await emit('paidUser.trendVid.success', {
      PaidJobId,
      email: job.email,
      channelId: job.channelId,
      channelName: job.channelName,
      TrendingVideos: job.TrendingVideos,
    })
  }
  return { status_code: 200, body: { success: true, message: 'Retry started' } }
})


const NICHE_PROMPT = (videos) => `
You are an expert in YouTube channel analysis.

Based ONLY on the following video TITLES,
identify the 1-2 main niches of the channel.

Rules:
- Focus on the overall channel theme
- Do NOT analyze individual videos
- Keep reason under 10 words

Return STRICT JSON ONLY:
{
  "niches": ["<niche1>", "<optional_niche2>"],
  "reason": "<10 words>"
}

Video titles:
${videos.map((v) => `- ${v.title}`).join('\n')}
`

freeStep('reachai-backend::resolve-channel', 'Resolve a YouTube handle to a channelId.', async (data, jobId, email) => {
  let channel = String(data.channel || '').trim()
  if (!channel.startsWith('@')) channel = '@' + channel

  const apiKey = process.env.YOUTUBE_API_KEY
  if (!apiKey) throw new Error('Youtube api key not configured')

  const job = (await sGet(SCOPES.jobs, jobId)) || {}
  await sSet(SCOPES.jobs, jobId, { ...job, status: 'resolving_channel' })

  const searchData = await youtubeSearch(
    { part: 'snippet', type: 'channel', q: channel.substring(1) },
    apiKey,
  )

  const channelId = searchData.items?.[0]?.snippet?.channelId || null
  const channelName = searchData.items?.[0]?.snippet?.title || ''

  if (!channelId) {
    await sSet(SCOPES.jobs, jobId, { ...job, status: 'failed_channel', error: 'channel not found' })
    await emit('yt.channel.error', { jobId, email })
    return
  }

  await emit('yt.channel.resolved', { jobId, channelId, channelName, email })
})

freeStep('reachai-backend::fetch-videos', 'Fetch the latest 10 videos of the channel.', async (data, jobId, email) => {
  const apiKey = process.env.YOUTUBE_API_KEY
  if (!apiKey) throw new Error('Youtube api key not configured')

  const job = (await sGet(SCOPES.jobs, jobId)) || {}
  await sSet(SCOPES.jobs, jobId, { ...job, status: 'fetching_videos' })

  const res = await youtubeSearch(
    { part: 'snippet', channelId: data.channelId, order: 'date', type: 'video', maxResults: '10' },
    apiKey,
  )

  if (!res.items?.length) {
    await sSet(SCOPES.jobs, jobId, { ...job, status: 'failed', error: 'No videos found' })
    await emit('yt.videos.error', { jobId, email, error: 'No videos found for this channel' })
    return
  }

  const videos = res.items.map((i) => ({
    videoId: i.id.videoId,
    description: i.snippet.description,
    title: i.snippet.title,
    url: `https://www.youtube.com/watch?v=${i.id.videoId}`,
    publishedAt: i.snippet.publishedAt,
    thumbnail: i.snippet.thumbnails.default.url,
  }))

  await sSet(SCOPES.jobs, jobId, { ...job, status: 'video fetched', videos })
  await emit('yt.videos.fetched', { jobId, channelName: data.channelName, videos, email, channelId: data.channelId })
})

freeStep('reachai-backend::fetch-niche', 'Detect channel niche from video titles with AI.', async (data, jobId, email) => {
  const job = await sGet(SCOPES.jobs, jobId)
  const UserVideos = job.videos
  if (!UserVideos) throw new Error('No user videos found in state or event payload')

  await sSet(SCOPES.jobs, jobId, { ...job, status: 'analyzing_niche' })

  const parsed = await aiJson({ system: 'You are a YouTube channel analysis assistant.', user: NICHE_PROMPT(UserVideos) })

  await sSet(SCOPES.jobs, jobId, {
    ...job,
    status: 'niche detected',
    niches: parsed.niches,
    reason: parsed.reason,
  })
  await emit('yt.niche.fetched', {
    jobId,
    email,
    channelName: data.channelName,
    channelId: data.channelId,
    niches: parsed.niches,
    reason: parsed.reason,
  })
})

freeStep('reachai-backend::fetch-trending', 'Fetch top-viewed videos in the detected niche.', async (data, jobId, email) => {
  const apiKey = process.env.YOUTUBE_API_KEY
  if (!apiKey) throw new Error('youtube api key not configured')

  const job = await sGet(SCOPES.jobs, jobId)
  const region = job?.region || 'IN'
  if (!job.videos) throw new Error('No user videos found in state or event payload')

  await sSet(SCOPES.jobs, jobId, { ...job, status: 'fetching_trending' })

  const res = await youtubeSearch(
    { part: 'snippet', q: data.niches[0], type: 'video', maxResults: '8', order: 'viewCount', regionCode: region },
    apiKey,
  )

  if (!res.items?.length) {
    await sSet(SCOPES.jobs, jobId, { ...job, status: 'failed', error: 'No Trending videos found' })
    await emit('yt.trendingVideos.error', { jobId, email, error: 'No Trending videos found for this niche' })
    return
  }

  const TrendingVideos = res.items.map((i) => ({
    videoId: i.id.videoId,
    title: i.snippet.title,
    channelTitle: i.snippet.channelTitle,
  }))

  await sSet(SCOPES.jobs, jobId, {
    ...job,
    status: 'Trending video fetched',
    TrendingVideos: TrendingVideos.slice(0, 8),
    region,
  })
  await emit('yt.trendingVideos.fetched', {
    jobId,
    region,
    channelId: data.channelId,
    email,
    channelName: data.channelName,
    TrendingVideos,
  })
})

freeStep('reachai-backend::generate-titles', 'Generate 2 optimized titles per video with AI.', async (data, jobId, email) => {
  const job = await sGet(SCOPES.jobs, jobId)
  const UserVideos = job.videos
  if (!UserVideos) throw new Error('No user videos found in state or event payload')

  const first5 = UserVideos.slice(0, 5)
  const { channelName, channelId, TrendingVideos } = data

  await sSet(SCOPES.jobs, jobId, { ...job, status: 'generating_titles' })

  const prompt = `
You are a YouTube SEO strategist and Title Optimization expert.

CHANNEL INFO:
Name: ${channelName}
Detected Niches: ${job.niches[0]} and ${job.niches[1]}
Why this niche was detected: ${job.reason}

FIRST analyze the *currently trending videos* in these niches. Learn their:
- Title formats
- Emotional hooks
- Keywords
- Style & pacing
- Click triggers

Trending videos reference:
${TrendingVideos.map((v, i) => `${i + 1}. ${v.title} (by ${v.channelTitle})`).join('\n')}

---

CREATOR'S 5 LATEST VIDEOS (understand tone, voice, and audience expectation):
${first5.map((v, i) => `${i + 1}. "${v.title}"`).join('\n')}

---

### YOUR MAIN TASK
For **EXACTLY THESE 5 VIDEOS ONLY** (NO MORE, NO LESS):

1. Generate **2 optimized, highly clickable, SEO-rich titles** for EACH video
2. Every title must follow these rules:
   - Short, punchy, emotional, keyword-focused
   - Inspired by niche + trending videos
   - Must use **ONLY ONE emoji**, placed at the end of the title
3. After the titles, write a short **1-2 sentence explanation** of why they will perform better.

---

### SPECIAL TASK FOR VIDEO #1 ONLY (Paid Bundle Preview)
For the FIRST video only, also generate:

- **Description (200-250 words)** - engaging, keyword-rich, retention-focused, not less than 150 words.
- **10-15 Tags** - comma separated, EXACTLY 10-15 high-intent SEO tags
- **10-15 Hashtags** - sharp, relevant, viral-friendly, title related, EXACTLY 10-15 high-intent SEO hashtags
- **WHY THIS WORKS** - A short 2-3 sentence explanation why these titles and metadata work better.

---

### OUTPUT FORMAT (CRITICAL - MUST RETURN EXACTLY 5 OBJECTS)
Return ONLY a valid JSON with EXACTLY 5 title objects in this structure:

{
  "titles": [
    {
      "original": "...",
      "improved1": "...",
      "improved2": "...",
      "why": "1-2 sentence explanation",
      "premium_metadata": {
          "description": "...",
          "tags": ["tag1", "tag2"],
          "hashtags": ["#tag1", "#tag2"],
          "Why_premium": "2-3 sentence explanation"
      }
    },
    {
      "original": "...",
      "improved1": "...",
      "improved2": "...",
      "why": "1-2 sentence explanation",
      "premium_metadata": null
    }
  ]
}

IMPORTANT:
- Return EXACTLY 5 title objects, one for each video
- Only video #1 should have premium_metadata filled
- Videos 2-5 should have premium_metadata: null
- Do NOT include anything outside the JSON.
`

  const parsed = await aiJson({
    system: 'You are a YouTube SEO and engagement expert who helps creators write better video titles',
    user: prompt,
  })

  if (!parsed.titles || parsed.titles.length !== 5) {
    if (parsed.titles) parsed.titles = parsed.titles.slice(0, 5)
    if (parsed.titles.length < 5 && first5.length === 5) {
      throw new Error(`AI must return exactly 5 titles, got ${parsed.titles?.length}`)
    }
  }

  const ImprovedTitles = parsed.titles.map((t, i) => ({
    original: t.original,
    improved1: t.improved1,
    improved2: t.improved2,
    Why: t.why,
    url: first5[i].url,
    thumbnail: first5[i].thumbnail,
    premium_metadata: t.premium_metadata,
  }))

  await sSet(SCOPES.jobs, jobId, { ...job, status: 'Titles ready', ImprovedTitles })
  await emit('yt.AI-Title.fetched', { jobId, email, channelName, channelId, ImprovedTitles })
})

freeStep('reachai-backend::send-titles-email', 'Send the optimized-titles email via Resend.', async (data, jobId, email) => {
  const { channelName, channelId } = data
  if (!channelId || !channelName) throw new Error('Missing channelId/channelName')

  let ImprovedTitles = data.ImprovedTitles || []
  let job = await sGet(SCOPES.jobs, jobId)
  if (!ImprovedTitles.length) {
    ImprovedTitles = job?.ImprovedTitles || []
    if (!ImprovedTitles.length) throw new Error('No Improved titles found.')
  }

  const finalTitles = ImprovedTitles.slice(0, 5)
  const first5 = (job?.videos || []).slice(0, 5)
  const titlesWithThumb = finalTitles.map((t, i) => ({
    ...t,
    thumbnail: first5[i]?.thumbnail || null,
    url: first5[i]?.url || t.url,
  }))

  if (job?.emailId && job?.status === 'completed') {
    await emit('yt.titles.Email-Send', { jobId, email, emailId: job.emailId, alreadySent: true })
    return
  }

  await sSet(SCOPES.jobs, jobId, { ...job, status: 'sending_email', updatedAt: new Date().toISOString() })

  let textBody = `Your Optimized YouTube Titles for ${channelName}\n\n`
  titlesWithThumb.forEach((t, i) => {
    textBody += `Video ${i + 1}\nOriginal: ${t.original}\nImproved 1: ${t.improved1}\nImproved 2: ${t.improved2}\n`
    if (t.Why) textBody += `Why: ${t.Why}\n`
    if (t.url) textBody += `Watch: ${t.url}\n`
    textBody += `\n--------------------------\n\n`
  })
  textBody += `Unlock full metadata for Rs 99:\n${process.env.FRONTEND_URL}/pay/${channelId}?email=${email}\nReachAI - Smarter YouTube Growth\n`

  const resJson = await sendEmail({
    from: process.env.RESEND_FROM_EMAIL,
    to: email,
    subject: `Your Optimized Titles for ${channelName}`,
    html: titlesEmailHtml(channelName, titlesWithThumb, channelId, email),
    text: textBody,
  })

  job = (await sGet(SCOPES.jobs, jobId)) || job
  await sSet(SCOPES.jobs, jobId, {
    ...job,
    status: 'completed',
    emailId: resJson?.id,
    completedAt: new Date().toISOString(),
  })
  await emit('yt.titles.Email-Send', { jobId, email, emailId: resJson?.id })
})

worker.registerFunction(
  'reachai-backend::error-handler',
  async (data) => {
    try {
      const job = (await sGet(SCOPES.jobs, data.jobId)) || {}
      const email = data.email || job.email
      const channelName = data.channelName || job.channelName
      if (!email) return console.error('missing email, cannot notify')

      await sendEmail({
        from: process.env.RESEND_FROM_EMAIL,
        to: email,
        subject: `Request failed for youtube titles optimization for channel ${channelName}`,
        text: `Sorry, We are facing issue in generating the optimized titles for your channel ${channelName}, Please try again.`,
      })
    } catch (error) {
      console.error('failed to send error notification', { error: error.message })
    }
  },
  { description: 'Free flow error handler: email the user when a step fails permanently.' },
)


paidStep(
  'reachai-backend::fetch-videos-paid',
  'Fetch latest 10 videos after payment.',
  'fetchVideos',
  'paidUser.videosfetched.error',
  async (data, PaidJobId) => {
    const job = await sGet(SCOPES.paidJobs, PaidJobId)
    if (!job) throw new Error('PaidJob not found')
    const { channelId, email } = job

    if (job.videosFetched === true) {
      return emit('paidUser.videosfetched.success', {
        PaidJobId,
        email,
        channelId,
        videos: job.videos,
      })
    }

    const apiKey = process.env.YOUTUBE_API_KEY
    if (!apiKey) throw new Error('Youtube api key not configured')

    await sSet(SCOPES.paidJobs, PaidJobId, { ...job, status: 'fetching videos.' })

    const res = await youtubeSearch(
      { part: 'snippet', channelId, order: 'date', type: 'video', maxResults: '10' },
      apiKey,
    )

    if (!res.items?.length) {
      await sSet(SCOPES.paidJobs, PaidJobId, { ...job, status: 'failed', error: 'No videos found' })
      await emit('paidUser.videosfetched.error', {
        PaidJobId,
        email,
        channelId,
        error: 'No videos found for this channel',
      })
      return
    }

    const channelName = res.items[0]?.snippet?.channelTitle || 'Unknown Channel'
    const videos = res.items.map((i) => ({
      videoId: i.id.videoId,
      description: i.snippet.description,
      title: i.snippet.title,
      url: `https://www.youtube.com/watch?v=${i.id.videoId}`,
      publishedAt: i.snippet.publishedAt,
      thumbnail: i.snippet.thumbnails.default.url,
    }))

    await sSet(SCOPES.paidJobs, PaidJobId, {
      ...job,
      channelName,
      status: 'video fetched',
      videosFetched: true,
      videos,
    })
    await emit('paidUser.videosfetched.success', { PaidJobId, channelName, videos, email, channelId })
  },
)

paidStep(
  'reachai-backend::fetch-niche-paid',
  'Detect channel niche with AI (paid flow).',
  'fetchNiche',
  'paidUser.Nichefetched.error',
  async (data, PaidJobId) => {
    const { email, channelName, channelId, videos } = data
    if (!PaidJobId || !email || !videos?.length) throw new Error('Missing required event data')

    const job = await sGet(SCOPES.paidJobs, PaidJobId)
    if (!job) throw new Error('PaidJob not found')

    if (job.nicheFetched === true) {
      return emit('paidUser.Nichefetched.success', {
        PaidJobId,
        email,
        channelId,
        channelName,
        niches: job.niches,
        reason: job.reason,
      })
    }

    await sSet(SCOPES.paidJobs, PaidJobId, { ...job, status: 'fetching_niche' })

    const parsed = await aiJson({ system: 'You are a YouTube channel analysis assistant.', user: NICHE_PROMPT(videos) })

    await sSet(SCOPES.paidJobs, PaidJobId, {
      ...job,
      status: 'niche_detected',
      nicheFetched: true,
      niches: parsed.niches,
      reason: parsed.reason,
    })
    await emit('paidUser.Nichefetched.success', {
      PaidJobId,
      email,
      channelName,
      channelId,
      niches: parsed.niches,
      reason: parsed.reason,
    })
  },
)

paidStep(
  'reachai-backend::fetch-trending-paid',
  'Fetch trending videos of the niche (paid flow).',
  'fetchTrendVid',
  'paidUser.trendVid.error',
  async (data, PaidJobId) => {
    const { email, channelId, channelName, niches } = data
    const niche = niches?.[0]
    if (!PaidJobId || !niche || !email) throw new Error('Missing required event data')

    const job = await sGet(SCOPES.paidJobs, PaidJobId)
    if (!job) throw new Error('PaidJob not found')
    const region = job?.region || 'IN'

    if (job.trendVidFetched === true) {
      return emit('paidUser.trendVid.success', {
        PaidJobId,
        region,
        channelId,
        email,
        channelName,
        TrendingVideos: job.TrendingVideos,
      })
    }

    const apiKey = process.env.YOUTUBE_API_KEY
    if (!apiKey) throw new Error('youtube api key not configured')

    await sSet(SCOPES.paidJobs, PaidJobId, { ...job, status: 'fetching trending videos of the niche.' })

    const res = await youtubeSearch(
      { part: 'snippet', q: niche, type: 'video', maxResults: '10', order: 'viewCount', regionCode: region },
      apiKey,
    )

    if (!res.items?.length) {
      await sSet(SCOPES.paidJobs, PaidJobId, { ...job, status: 'failed', error: 'No Trending videos found' })
      await emit('paidUser.trendVid.error', { PaidJobId, email, error: 'No Trending videos found for this niche' })
      return
    }

    const TrendingVideos = res.items.map((i) => ({
      videoId: i.id.videoId,
      title: i.snippet.title,
      channelTitle: i.snippet.channelTitle,
      description: i.snippet.description,
    }))

    await sSet(SCOPES.paidJobs, PaidJobId, {
      ...job,
      trendVidFetched: true,
      status: 'Trending videos fetched',
      TrendingVideos: TrendingVideos.slice(0, 8),
      region,
    })
    await emit('paidUser.trendVid.success', {
      PaidJobId,
      region,
      channelId,
      email,
      channelName,
      TrendingVideos,
    })
  },
)

paidStep(
  'reachai-backend::generate-metadata-paid',
  'Generate full metadata for all videos with AI (paid flow).',
  'fetchAiMetadata',
  'paidUser.AImetadata.error',
  async (data, PaidJobId) => {
    const { email, channelId, channelName, TrendingVideos } = data
    if (!PaidJobId || !email || !channelId) throw new Error('Missing required event data')

    const job = await sGet(SCOPES.paidJobs, PaidJobId)
    if (!job) throw new Error('PaidJob not found')

    if (job.AiMetadatafetched === true) {
      return emit('paidUser.AImetadata.success', {
        PaidJobId,
        email,
        channelId,
        channelName,
        ImprovedMetadataData: job.ImprovedMetadataData,
      })
    }

    const UserVideos = job.videos
    if (!Array.isArray(UserVideos) || !UserVideos.length) throw new Error('No user videos found')

    const TOTAL = UserVideos.length
    await sSet(SCOPES.paidJobs, PaidJobId, { ...job, status: 'fetching AI optimized metadata' })

    const prompt = `
You are an expert YouTube SEO, Metadata, and Growth Strategist.

CHANNEL CONTEXT
Channel Name: ${channelName}
Primary Niches: ${job.niches?.[0] || ''}, ${job.niches?.[1] || ''}
Why this niche: ${job.reason || ''}

TRENDING PATTERNS:
${TrendingVideos.slice(0, 5).map((v) => `- ${v.title}`).join('\n')}

CREATOR VIDEOS TO OPTIMIZE:
${UserVideos.map((v, i) => `${i + 1}. ${v.title}`).join('\n')}

CRITICAL REQUIREMENT:
- You WILL receive ${TOTAL} creator video titles.
- You MUST return metadata for ALL ${TOTAL} videos.
- Do NOT skip any title.
- Do NOT merge videos.
- If output would be long, compress descriptions slightly,
  but NEVER reduce the number of videos.

TASK:
For EACH video generate:
- 2 optimized titles (1 emoji at end, 50-60 chars each)
- Description: MINIMUM 170 words, naturally keyword-rich
- Tags: EXACTLY 15-20 high-intent SEO tags
- Hashtags: EXACTLY 15-20 trending niche hashtags (#format)
- Why: 2-3 sentence about explaining why this generated metadata works.

STRICT JSON OUTPUT ONLY:

{
  "videos": [
    {
      "original_title": "...",
      "optimized_title_1": "...",
      "optimized_title_2": "...",
      "optimized_description": "...",
      "tags": ["...", "..."],
      "hashtags": ["...", "..."],
      "why": "..."
    }
  ]
}

IMPORTANT:
- videos.length MUST equal ${TOTAL}
- Output ONLY valid JSON
`

    const parsed = await aiJson({
      system: 'You are a YouTube SEO expert producing high-quality metadata in strict valid JSON output.',
      user: prompt,
      temperature: 0.5,
      maxTokens: 6000,
    })

    if (!parsed.videos?.length || parsed.videos.length !== TOTAL) {
      throw new Error(`AI returned ${parsed.videos?.length || 0} of ${TOTAL}`)
    }

    const ImprovedMetadataData = parsed.videos.map((m, i) => ({ ...m, url: UserVideos[i]?.url }))

    await sSet(SCOPES.paidJobs, PaidJobId, {
      ...job,
      status: 'AI metadata ready',
      AiMetadatafetched: true,
      ImprovedMetadataData,
    })
    await emit('paidUser.AImetadata.success', {
      PaidJobId,
      email,
      channelName,
      channelId,
      ImprovedMetadataData,
    })
  },
)

paidStep(
  'reachai-backend::send-metadata-email-paid',
  'Send the full-metadata email via Resend (paid flow).',
  'sendEmailPaid',
  'PaidUser.Email-Send.error',
  async (data, PaidJobId) => {
    const { email, channelName, channelId } = data
    if (!email || !channelId || !channelName) throw new Error('Missing required event data')

    const job = await sGet(SCOPES.paidJobs, PaidJobId)
    if (job?.emailSent === true) return console.log('Email already sent - skipping', { PaidJobId })

    const ImprovedMetadataData = job?.ImprovedMetadataData || []
    if (!ImprovedMetadataData.length) throw new Error('No ImprovedMetadataData found in state')
    if (ImprovedMetadataData.length !== job.videos.length) {
      throw new Error(`Email metadata mismatch: expected ${job.videos.length}, got ${ImprovedMetadataData.length}`)
    }

    const MetadataWithThumb = ImprovedMetadataData.map((m, i) => ({
      ...m,
      thumbnail: job.videos[i]?.thumbnail || null,
      url: job.videos[i]?.url || m.url,
    }))

    let textBody = `Your Optimized metadata for your youtube channel ${channelName}\n\n`
    MetadataWithThumb.forEach((t, i) => {
      textBody += `Video ${i + 1}\nOriginal: ${t.original_title}\nImproved title 1: ${t.optimized_title_1}\nImproved title 2: ${t.optimized_title_2}\nDescription: ${t.optimized_description}\nTags: ${t.tags}\nHashtags: ${t.hashtags}\n`
      if (t.why) textBody += `Why: ${t.why}\n`
      if (t.url) textBody += `Watch: ${t.url}\n`
      textBody += `\n--------------------------\n\n`
    })
    textBody += 'ReachAI - Smarter YouTube Growth\n'

    const resJson = await sendEmail({
      from: process.env.RESEND_FROM_EMAIL,
      to: email,
      subject: `Your Optimized metadata for ${channelName}`,
      html: metadataEmailHtml(channelName, MetadataWithThumb),
      text: textBody,
      idempotencyKey: `paidjob-email-${PaidJobId}`,
    })

    await sSet(SCOPES.paidJobs, PaidJobId, {
      ...job,
      status: 'completed',
      emailSent: true,
      emailSentAt: new Date().toISOString(),
      emailId: resJson?.id,
      completedAt: new Date().toISOString(),
    })
    await emit('PaidUser.Email-Send.success', { PaidJobId, email, emailId: resJson?.id })
  },
)

worker.registerFunction(
  'reachai-backend::error-handler-paid',
  async (data) => {
    const { PaidJobId, email, channelName, error } = data
    try {
      console.error('Paid workflow failed permanently', { PaidJobId, error })

      if (email) {
        await sendEmail({
          from: process.env.RESEND_FROM_EMAIL,
          to: email,
          subject: `Request failed for youtube metadata optimization for channel ${channelName}`,
          text: `
Sorry! There is an issue while processing your request for your channel ${channelName}, Something went wrong during processing.
But if your payment was successful then contact us we will help you as soon as possible.
Contact support: https://reachaiapp.online/contact
Please include your Payment ID and this Job ID when contacting support:
${PaidJobId}`.trim(),
        })
      }

      const job = await sGet(SCOPES.paidJobs, PaidJobId)
      if (job) {
        await sSet(SCOPES.paidJobs, PaidJobId, {
          ...job,
          status: 'failed_permanently',
          finalError: job.lastError || 'Unknown error',
          failedAt: new Date().toISOString(),
        })
      }
    } catch (err) {
      console.error('failed to send error notification')
    }
  },
  { description: 'Paid flow error handler: email the user and mark the job permanently failed.' },
)

worker.registerFunction(
  'reachai-backend::flow-complete',
  async (data) => {
    console.log('Flow completed', { jobId: data.jobId, PaidJobId: data.PaidJobId, emailId: data.emailId })
    return { ok: true }
  },
  { description: 'Terminal no-op for flow completion events.' },
)

function titlesEmailHtml(channelName, titles, channelId, email) {
  const urlCTA = `${process.env.FRONTEND_URL}/pay/${channelId}?email=${email}`
  const premium = titles[0].premium_metadata

  const cards = titles
    .map(
      (t, i) => `
<tr><td style="padding:12px 8px;">
  <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:10px;border-collapse:separate;border-spacing:0;overflow:hidden;">
    <tr><td style="padding:12px;border-radius:10px;">
      <table width="100%"><tr>
        <td style="font-size:14px;font-weight:700;color:#111;">&#127916; Video ${i + 1}</td>
        <td align="right"><a href="${urlCTA}" style="font-size:12px;color:#d00000;text-decoration:none;font-weight:600;">Unlock Full Metadata &rarr;</a></td>
      </tr></table>
      ${
        thumbFor(t.url, t.thumbnail)
          ? `<table width="100%" style="margin-top:10px;"><tr><td align="center"><img src="${thumbFor(t.url, t.thumbnail)}" width="100%" style="max-width:620px;height:auto;border-radius:10px;"></td></tr></table>`
          : ''
      }
      <table width="100%" style="margin-top:14px;">
        <tr><td style="font-size:14px;font-weight:700;text-transform:uppercase;color:#444;">Original Title</td></tr>
        <tr><td style="font-size:14px;color:#222;padding-top:4px;">${esc(t.original)}</td></tr>
      </table>
      <table width="100%" style="margin-top:14px;">
        <tr><td style="font-size:14px;font-weight:700;text-transform:uppercase;color:#d00000;">Optimized Titles</td></tr>
        <tr><td style="background:#fffdf0;border-radius:6px;padding:10px;font-size:14px;color:#333;"><span style="font-weight:700;color:#ff0000;">1:</span> ${esc(t.improved1)}</td></tr>
        <tr><td height="8"></td></tr>
        <tr><td style="background:#fffdf0;border-radius:6px;padding:10px;font-size:14px;color:#333;"><span style="font-weight:700;color:#ff0000;">2:</span> ${esc(t.improved2)}</td></tr>
      </table>
      ${
        t.Why
          ? `<table width="100%" style="margin-top:14px;"><tr><td style="background:#fff4cd;padding:12px;border-radius:6px;">
        <div style="font-size:12px;color:#92400e;font-weight:700;text-transform:uppercase;margin-bottom:4px;">&#128161; Why This Works</div>
        <div style="font-size:13px;color:#7a3c07;line-height:1.45;">${esc(t.Why)}</div>
      </td></tr></table>`
          : ''
      }
    </td></tr>
  </table>
</td></tr>`,
    )
    .join('')

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<style>table{border-collapse:collapse}img{display:block;outline:none;text-decoration:none}body{margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif;background:#ffffff}</style>
</head>
<body>
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#ffffff"><tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="max-width:650px;margin:auto;">
  <tr><td style="padding:24px 16px 10px 16px;font-size:20px;font-weight:700;color:#111;">Hey Creator &#128075;</td></tr>
  <tr><td style="padding:0 16px 14px 16px;font-size:14px;color:#555;line-height:1.6;">
    Your AI-powered, trend-driven &amp; SEO-optimized titles for <strong style="color:#111;">${esc(channelName)}</strong> are ready.<br>
    These are generated using real-time niche performance, CTR psychology, and keyword signals from your recent uploads.
  </td></tr>
  <tr><td style="padding:0 8px;">
    <div style="font-size:16px;font-weight:700;color:#111;border-left:4px solid #ff0000;padding:12px 0 12px 12px;">
      Optimized Titles <span style="color:#666;font-weight:400;margin-left:8px;font-size:13px;">(${titles.length} videos)</span>
    </div>
  </td></tr>
  ${cards}
  <tr><td style="padding:20px 6px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:10px;border-collapse:separate;border-spacing:0;overflow:hidden;">
      <tr><td style="background:#111;border-radius:10px 10px 0 0;padding:16px;text-align:center;">
        <div style="font-size:18px;font-weight:700;color:#ffffff;">&#128275; Unlock Complete SEO Data</div>
        <div style="padding-top:4px;font-size:12px;color:#bfbfbf;">Titles &bull; Descriptions &bull; Tags &bull; Hashtags</div>
      </td></tr>
      <tr><td style="padding:8px;border-radius:0 0 10px 10px;">
        <table width="100%"><tr><td align="center">
          <img src="${thumbFor(titles[0].url, titles[0].thumbnail, 'maxresdefault')}" width="100%" style="max-width:634px;border-radius:8px;">
        </td></tr></table>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
          <tr><td style="background:#f9fafb;padding:14px 16px;border-bottom:1px solid #e5e7eb;">
            <span style="font-size:14px;font-weight:700;color:#111;">Video 1 Example:</span>
          </td></tr>
          <tr><td style="padding:16px;background:#ffffff;">
            <div style="font-size:12px;text-transform:uppercase;font-weight:700;color:#6b7280;">Original Title</div>
            <div style="padding-top:4px;font-size:14px;color:#111;">${esc(titles[0].original)}</div>
            <div style="height:14px;"></div>
            <div style="font-size:12px;text-transform:uppercase;font-weight:700;color:#d00000;">Optimized Titles</div>
            <div style="background:#fffafa;border-radius:4px;padding:8px;font-size:13px;color:#111;"><span style="font-weight:700;color:#d00000;">1:</span> ${esc(titles[0].improved1)}</div>
            <div style="background:#fffafa;border-radius:4px;padding:8px;font-size:13px;color:#111;margin-top:6px;"><span style="font-weight:700;color:#d00000;">2:</span> ${esc(titles[0].improved2)}</div>
            ${
              premium
                ? `
            <div style="height:14px;"></div>
            <div style="font-size:12px;text-transform:uppercase;font-weight:700;color:#6b7280;">Preview Description</div>
            <div style="padding-top:4px;font-size:13px;color:#333;line-height:1.5;">${esc(String(premium.description || '').slice(0, 500))}${premium.description?.length > 500 ? '...' : ''}</div>
            <div style="height:14px;"></div>
            <div style="font-size:12px;text-transform:uppercase;font-weight:700;color:#6b7280;">Tags</div>
            <div style="padding-top:4px;font-size:13px;color:#333;">${(premium.tags || []).map(esc).join(', ')}</div>
            <div style="height:14px;"></div>
            <div style="font-size:12px;text-transform:uppercase;font-weight:700;color:#6b7280;">Hashtags</div>
            <div style="padding-top:4px;font-size:13px;color:#333;">${(premium.hashtags || []).map(esc).join(' ')}</div>
            <div style="height:14px;"></div>
            <div style="background:#fff4cd;padding:12px;border-radius:6px;">
              <div style="font-size:12px;color:#92400e;font-weight:700;text-transform:uppercase;margin-bottom:4px;">Why This Works</div>
              <div style="font-size:13px;color:#7a3c07;line-height:1.45;">${esc(premium.Why_premium || '')}</div>
            </div>`
                : ''
            }
          </td></tr>
        </table>
        <table width="100%" style="margin-top:16px;"><tr><td align="center">
          <a href="${urlCTA}" style="background:#d00000;color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;padding:14px 32px;border-radius:8px;display:inline-block;">Unlock Full Metadata for &#8377;99 &rarr;</a>
        </td></tr></table>
      </td></tr>
    </table>
  </td></tr>
</table>
</td></tr></table>
</body></html>`
}

function metadataEmailHtml(channelName, items) {
  const cards = items
    .map(
      (t, i) => `
<tr><td style="padding:12px 8px;">
  <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:10px;border-collapse:separate;border-spacing:0;overflow:hidden;">
    <tr><td style="padding:12px;border-radius:10px;">
      <div style="font-size:14px;font-weight:700;color:#111;margin-bottom:8px;">&#127916; Video ${i + 1}</div>
      ${
        thumbFor(t.url, t.thumbnail)
          ? `<table width="100%"><tr><td align="center"><img src="${thumbFor(t.url, t.thumbnail)}" width="100%" style="max-width:620px;height:auto;border-radius:10px;"></td></tr></table>`
          : ''
      }
      <table width="100%" style="margin-top:14px;">
        <tr><td style="font-size:12px;font-weight:700;text-transform:uppercase;color:#6b7280;">Original Title</td></tr>
        <tr><td style="font-size:14px;color:#111;padding-top:4px;">${esc(t.original_title)}</td></tr>
      </table>
      <table width="100%" style="margin-top:12px;">
        <tr><td style="font-size:12px;font-weight:700;text-transform:uppercase;color:#d00000;">Optimized Titles</td></tr>
        <tr><td style="background:#fffdf0;border-radius:6px;padding:10px;font-size:14px;color:#333;"><span style="font-weight:700;color:#ff0000;">1:</span> ${esc(t.optimized_title_1)}</td></tr>
        <tr><td height="8"></td></tr>
        <tr><td style="background:#fffdf0;border-radius:6px;padding:10px;font-size:14px;color:#333;"><span style="font-weight:700;color:#ff0000;">2:</span> ${esc(t.optimized_title_2)}</td></tr>
      </table>
      <table width="100%" style="margin-top:12px;">
        <tr><td style="font-size:12px;font-weight:700;text-transform:uppercase;color:#6b7280;">Optimized Description</td></tr>
        <tr><td style="font-size:13px;color:#333;line-height:1.55;padding-top:4px;">${esc(t.optimized_description)}</td></tr>
      </table>
      <table width="100%" style="margin-top:12px;">
        <tr><td style="font-size:12px;font-weight:700;text-transform:uppercase;color:#6b7280;">Tags</td></tr>
        <tr><td style="font-size:13px;color:#333;padding-top:4px;">${(t.tags || []).map(esc).join(', ')}</td></tr>
      </table>
      <table width="100%" style="margin-top:12px;">
        <tr><td style="font-size:12px;font-weight:700;text-transform:uppercase;color:#6b7280;">Hashtags</td></tr>
        <tr><td style="font-size:13px;color:#333;padding-top:4px;">${(t.hashtags || []).map(esc).join(' ')}</td></tr>
      </table>
      ${
        t.why
          ? `<table width="100%" style="margin-top:12px;"><tr><td style="background:#fff4cd;padding:12px;border-radius:6px;">
        <div style="font-size:12px;color:#92400e;font-weight:700;text-transform:uppercase;margin-bottom:4px;">&#128161; Why This Works</div>
        <div style="font-size:13px;color:#7a3c07;line-height:1.45;">${esc(t.why)}</div>
      </td></tr></table>`
          : ''
      }
    </td></tr>
  </table>
</td></tr>`,
    )
    .join('')

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<style>table{border-collapse:collapse}img{display:block;outline:none;text-decoration:none}body{margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif;background:#ffffff}</style>
</head>
<body>
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#ffffff"><tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="max-width:650px;margin:auto;">
  <tr><td style="padding:24px 16px 10px 16px;font-size:20px;font-weight:700;color:#111;">Hey Creator &#128075;</td></tr>
  <tr><td style="padding:0 16px 14px 16px;font-size:14px;color:#555;line-height:1.6;">
    Your complete AI-optimized metadata for <strong style="color:#111;">${esc(channelName)}</strong> is ready.<br>
    Titles, descriptions, tags and hashtags for every video - powered by real-time niche performance and keyword signals.
  </td></tr>
  ${cards}
</table>
</td></tr></table>
</body></html>`
}

console.log('[reachai-backend] single-file worker registered with all routes and flow steps')

for (const [function_id, topics] of Object.entries(SUBSCRIPTIONS)) {
  for (const queue of topics) {
    worker.registerTrigger({
      type: 'durable:subscriber',
      function_id,
      config: { queue, max_retries: PAID_ATTEMPTS, backoff_ms: 1000 },
    })
  }
}

process.on('SIGTERM', async () => {
  await worker.shutdown()
  process.exit(0)
})
