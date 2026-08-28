import { worker, SCOPES, sGet, sSet, emit, youtubeSearch, aiJson, sendEmail, esc, thumbFor, paidStep } from './worker.js'

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
      to: email,
      subject: `Your Optimized metadata for ${channelName}`,
      html: metadataEmailHtml(channelName, MetadataWithThumb),
      text: textBody,
    })

    await sSet(SCOPES.paidJobs, PaidJobId, {
      ...job,
      status: 'completed',
      emailSent: true,
      emailSentAt: new Date().toISOString(),
      emailId: resJson?.message_id,
      completedAt: new Date().toISOString(),
    })
    await emit('PaidUser.Email-Send.success', { PaidJobId, email, emailId: resJson?.message_id })
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
