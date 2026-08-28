import { worker, SCOPES, sGet, sSet, emit, youtubeSearch, aiJson, sendEmail, esc, thumbFor, freeStep } from './worker.js'

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
    to: email,
    subject: `Your Optimized Titles for ${channelName}`,
    html: titlesEmailHtml(channelName, titlesWithThumb, channelId, email),
    text: textBody,
  })

  job = (await sGet(SCOPES.jobs, jobId)) || job
  await sSet(SCOPES.jobs, jobId, {
    ...job,
    status: 'completed',
    emailId: resJson?.message_id,
    completedAt: new Date().toISOString(),
  })
  await emit('yt.titles.Email-Send', { jobId, email, emailId: resJson?.message_id })
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
