import crypto from 'node:crypto'
import { SCOPES, sGet, sSet, emit, sendEmail, razorpayCreateOrder, route } from './worker.js'

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
    await sendEmail({
      account: 'support',
      to: process.env.MERA_EMAIL,
      replyTo: email,
      subject: 'New Contact Form Message',
      html: `<h3>New Support Message</h3><p><strong>Name:</strong> ${name}</p><p><strong>Email:</strong> ${email}</p><p><strong>Message:</strong></p><p>${message}</p>`,
    })
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
