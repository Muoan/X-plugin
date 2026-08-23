import { fetchText } from './fetch.js'
import { getConfig } from './config.js'
import { getStatus } from './proxy.js'

const X_REG = /(?:https?:\/\/)?(?:www\.|mobile\.|m\.)?(?:x|twitter)\.com\/(?:#!\/)?([A-Za-z0-9_]{1,20})\/status\/(\d+)/i

/** TweetDetail 接口候选 */
const QUERY_IDS = [
  'XMOz5h24KAZ86qKffKTLdQ',
  '_iJccJ-mHcyaV0nq_odmBA',
  'FpV6tM0P8R0zH8oVl8hHmA',
  'V94PmY5J0qQd9Y2F1mQ9eQ',
  'qdtN9d7HIvPKzE7rQ3A9Nw'
]

/** 解析 Cookie（整串或 auth_token;ct0） */
function parseCookie (cookie) {
  const c = String(cookie || '').trim()
  if (!c) return null
  if (/;/.test(c)) {
    const pick = (k) => { const m = c.match(new RegExp(k + '=([^;\\s]+)')); return m ? m[1] : '' }
    return { auth: pick('auth_token'), ct0: pick('ct0'), raw: c }
  }
  const m = c.match(/auth_token=([^;\s]+)/)
  return m ? { auth: m[1], ct0: '', raw: c } : { auth: c, ct0: '', raw: '' }
}

/** 检查 Cookie 有效性 */
export async function checkCookie (cookie) {
  const ck = parseCookie(cookie)
  if (!ck || !ck.auth) return { ok: false, msg: '未配置 Cookie' }
  const raw = ck.raw || `auth_token=${ck.auth}; ct0=${ck.ct0 || ''}`
  const headers = {
    authorization: 'Bearer AAAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
    cookie: raw,
    'x-csrf-token': ck.ct0 || '',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    accept: '*/*',
    'x-twitter-active-user': 'yes',
    'x-twitter-client-language': 'zh-cn',
    'x-twitter-auth-type': 'OAuth2Session',
    referer: 'https://x.com/home',
    origin: 'https://x.com'
  }
  try {
    const res = await fetchText('https://x.com/i/api/1.1/account/settings.json', { proxy: true, timeout: 15000, headers })
    if (res.status === 200) {
      const j = JSON.parse(res.body)
      return { ok: true, msg: `✅ 有效（账号 ${j.screen_name || j.username || ''}）` }
    }
    const code = (() => { try { return JSON.parse(res.body).errors?.[0]?.code } catch { return null } })()
    return { ok: false, msg: `❌ 无效（HTTP ${res.status}${code ? ' code ' + code : ''}）——请重新复制 Cookie` }
  } catch (err) {
    return { ok: false, msg: `❌ 检查失败：${err.message}` }
  }
}

/** 抓推文评论（官方 GraphQL） */
export async function getComments (tweetId, cookie) {
  const ck = parseCookie(cookie)
  if (!ck || !ck.auth) return null
  const raw = ck.raw || `auth_token=${ck.auth}; ct0=${ck.ct0 || ''}`
  const cfg = getConfig()
  const qid = (cfg.x && cfg.x.tweetDetailQueryId) || ''
  const ids = qid ? [qid] : QUERY_IDS
  const headers = {
    authorization: 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
    cookie: raw,
    'x-csrf-token': ck.ct0 || '',
    'content-type': 'application/json',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'x-twitter-active-user': 'yes',
    'x-twitter-client-language': 'zh-cn',
    'x-twitter-auth-type': 'OAuth2Session',
    referer: `https://x.com/i/status/${tweetId}`,
    origin: 'https://x.com'
  }
  const variables = {
    focalTweetId: tweetId,
    referrer: 'profile',
    controller_data: 'DAACAAAA',
    rankingMode: 'Relevance',
    includePromotedContent: true,
    withCommunity: true
  }
  const features = {
    rweb_video_timestamps_enabled: true,
    rweb_tipjar_consumption_enabled: true,
    responsive_web_graphql_exclude_directive_enabled: true,
    verified_phone_label_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    tweetypie_unmention_optimization_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: false,
    tweet_awards_web_tipping_enabled: false,
    freedom_of_speech_not_reach_fetch_enabled: false,
    standardized_nudges_misinfo: false,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: true,
    responsive_web_enhance_cards_enabled: false
  }
  for (const id of ids) {
    const url = `https://x.com/i/api/graphql/${id}/TweetDetail?variables=${encodeURIComponent(JSON.stringify(variables))}&features=${encodeURIComponent(JSON.stringify(features))}`
    try {
      const res = await fetchText(url, { proxy: true, timeout: 15000, headers })
      if (res.status !== 200) continue
      const json = JSON.parse(res.body)
      const list = extractComments(json, tweetId)
      if (list) return list
    } catch { /* 试下一个 */ }
  }
  return null
}

/** 提取评论列表 */
function extractComments (json, tweetId) {
  const tl = json?.data?.threaded_conversation_with_injections_v2
  if (!tl) return null
  const out = []
  const seen = new Set()
  const pushOne = (r) => {
    const legacy = r?.legacy
    if (!legacy || !legacy.id_str) return
    if (legacy.id_str === tweetId) return
    if (seen.has(legacy.id_str)) return
    seen.add(legacy.id_str)
    const u = r?.core?.user_results?.result?.legacy || {}
    out.push({
      id: legacy.id_str,
      name: u.name || '',
      screen_name: u.screen_name || '',
      avatar_url: (u.profile_image_url_https || '').replace(/_normal(\.(?:jpg|jpeg|png|webp))$/, '_200x200$1'),
      text: legacy.full_text || '',
      likes: legacy.favorite_count || 0,
      created_at: legacy.created_at || ''
    })
  }
  for (const inst of tl.instructions || []) {
    if (inst.type !== 'TimelineAddEntries') continue
    for (const entry of inst.entries || []) {
      const content = entry?.content
      if (!content) continue
      if (content.itemContent?.tweet_results?.result) {
        pushOne(content.itemContent.tweet_results.result)
      }
      if (Array.isArray(content.items)) {
        for (const sub of content.items) {
          if (sub?.item?.itemContent?.tweet_results?.result) {
            pushOne(sub.item.itemContent.tweet_results.result)
          }
        }
      }
    }
  }
  return out
}

/** 提取推文链接 */
export function extractXUrl (text) {
  const m = String(text || '').match(X_REG)
  if (!m) return null
  return {
    url: /^https?:\/\//i.test(m[0]) ? m[0] : `https://${m[0]}`,
    user: m[1],
    id: m[2]
  }
}

/** 获取推文 */
export async function getTweet (info, { useProxyFallback = true } = {}) {
  const cfg = getConfig()
  const api = `${cfg.x.apiBase}/${encodeURIComponent(info.user)}/status/${info.id}`
  const errors = []

  try {
    const res = await fetchText(api, { timeout: 15000 })
    if (res.status === 200) {
      const json = JSON.parse(res.body)
      if (json.code === 200) return { source: 'direct', tweet: json.tweet }
      errors.push(`API: ${json.message || json.code}`)
    } else {
      errors.push(`直连 HTTP ${res.status}`)
    }
  } catch (err) {
    errors.push(err.message)
  }

  if (useProxyFallback && getStatus().enabled) {
    try {
      const res = await fetchText(api, { proxy: true, timeout: 20000 })
      if (res.status === 200) {
        const json = JSON.parse(res.body)
        if (json.code === 200) return { source: 'proxy', tweet: json.tweet }
        errors.push(`API: ${json.message || json.code}`)
      } else {
        errors.push(`代理 HTTP ${res.status}`)
      }
    } catch (err) {
      errors.push(`代理: ${err.message}`)
    }
  } else if (useProxyFallback && !getStatus().enabled) {
    errors.push('（可 #X代理开 启用代理后自动重试）')
  }

  throw new Error(errors.join('；') || '未知错误')
}

/** 挑下载资源（视频优先，纯图全下） */
export function pickDownloadUrls (tweet) {
  const media = tweet.media?.all || []
  const vids = []
  const imgs = []
  for (const item of media) {
    if (item.type === 'video' || item.type === 'gif') {
      const variants = (item.variants || [])
        .filter(v => (v.content_type || '').includes('mp4'))
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))
      if (variants[0]?.url) vids.push({ url: variants[0].url, kind: item.type === 'gif' ? 'GIF' : '视频' })
    } else if ((item.type === 'image' || item.type === 'photo') && item.url) {
      imgs.push({ url: item.url, kind: '图片' })
    }
  }
  if (vids.length) return vids
  return imgs
}

/** 媒体转链接 */
export function formatMedia (tweet) {
  const lines = []
  const media = tweet.media?.all || []
  for (const item of media) {
    if (item.type === 'video' || item.type === 'gif') {
      const variants = (item.variants || [])
        .filter(v => (v.content_type || '').includes('mp4'))
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))
      const best = variants[0] || (item.url ? { url: item.url } : null)
      const dur = item.duration
        ? `${Math.floor(item.duration / 60)}:${String(Math.floor(item.duration % 60)).padStart(2, '0')}`
        : ''
      const kind = item.type === 'gif' ? 'GIF' : '视频'
      const size = item.width ? ` ${item.width}x${item.height}` : ''
      lines.push(`${kind}${dur ? ` (${dur})` : ''}${size}:`)
      lines.push(best ? best.url : '（无直链）')
      if (item.type === 'video' && variants.length > 1) {
        const alt = variants.slice(1)
          .map(v => `· ${v.bitrate ? Math.round(v.bitrate / 1000) + 'kbps' : '?'} ${v.url}`)
          .join('\n')
        lines.push(`其他清晰度:\n${alt}`)
      }
      if (item.thumbnail_url) lines.push(`🖼 封面: ${item.thumbnail_url}`)
    } else if ((item.type === 'image' || item.type === 'photo') && item.url) {
      lines.push(`🖼 图片: ${item.url}`)
    }
  }
  return lines
}

export function fmtNum (n) {
  const v = Number(n || 0)
  if (v >= 10000) return `${(v / 10000).toFixed(1)}万`
  return String(v)
}

export function truncate (text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/** 组装消息 */
export function buildXMessage (tweet, source) {
  const a = tweet.author || {}
  const lines = []
  lines.push(`📱 X 资源解析${source === 'proxy' ? '（经代理）' : ''}`)
  if (tweet.possibly_sensitive) lines.push('⚠️ 该推文可能包含敏感内容')
  lines.push(`👤 ${a.name || a.screen_name || '未知用户'}${a.screen_name ? ` @${a.screen_name}` : ''}`)
  if (tweet.text) lines.push(`📝 ${truncate(tweet.text, 300)}`)
  const stats = []
  if (tweet.views) stats.push(`👀 ${fmtNum(tweet.views)}`)
  if (tweet.likes) stats.push(`👍 ${fmtNum(tweet.likes)}`)
  if (tweet.retweets) stats.push(`🔁 ${fmtNum(tweet.retweets)}`)
  if (stats.length) lines.push(stats.join(' '))
  lines.push('━━━━━━━━━━━━')
  const media = formatMedia(tweet)
  if (media.length) lines.push(...media)
  else lines.push('（该推文没有视频/图片/GIF 资源）')
  lines.push('━━━━━━━━━━━━')
  lines.push(`🔗 原文: ${tweet.url}`)
  return lines.join('\n')
}

/** 推文渲染页（仿 x.com UI） */
export function renderTweetHtml (tweet, comments) {
  const a = tweet.author || {}
  const esc = (s) => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const fmt = (n) => n >= 1000000 ? (n / 1000000).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n || 0)
  const media = tweet.media || {}
  const all = media.all || []
  const imgs = []
  const vids = []
  const resRows = []
  let imgN = 0
  let vidN = 0
  for (const item of all) {
    const w = item.width || 0
    const h = item.height || 0
    const dim = w && h ? ` ${w}x${h}` : ''
    if (item.type === 'photo') {
      imgN++
      const url = item.url || ''
      imgs.push(`<img src="/img?u=${encodeURIComponent(url)}" alt="photo ${imgN}" loading="lazy" onclick="window.open(this.src)">`)
      resRows.push(`<div class="res-row"><span class="res-ico">🖼</span><span class="res-name">图片 ${imgN}${dim}</span><a class="res-link" href="/img?u=${encodeURIComponent(url)}" target="_blank" rel="noopener">${esc(url)}</a><button class="res-copy" data-u="${esc(url)}" onclick="cp(this)">📋 复制</button></div>`)
    } else if (item.type === 'video' || item.type === 'gif') {
      vidN++
      const variants = (item.variants || []).filter(v => (v.content_type || '').includes('mp4')).sort((x, y) => (y.bitrate || 0) - (x.bitrate || 0))
      const best = variants[0] || (item.url ? { url: item.url } : null)
      const url = best ? best.url : ''
      const dur = item.duration ? `${Math.floor(item.duration / 60)}:${String(Math.floor(item.duration % 60)).padStart(2, '0')}` : ''
      const kind = item.type === 'gif' ? 'GIF' : '视频'
      const poster = item.thumbnail_url ? ` poster="/img?u=${encodeURIComponent(item.thumbnail_url)}"` : ''
      vids.push(item.type === 'gif'
        ? `<video controls loop muted autoplay playsinline preload="metadata" src="/img?u=${encodeURIComponent(url)}"${poster}></video>`
        : `<video controls preload="metadata" src="/img?u=${encodeURIComponent(url)}"${poster}></video>`)
      resRows.push(`<div class="res-row"><span class="res-ico">${item.type === 'gif' ? '🎞' : '🎬'}</span><span class="res-name">${kind}${dur ? ` ${dur}` : ''}${dim}</span><a class="res-link" href="/img?u=${encodeURIComponent(url)}" target="_blank" rel="noopener">${esc(url)}</a><button class="res-copy" data-u="${esc(url)}" onclick="cp(this)">📋 复制</button></div>`)
    }
  }
  const when = tweet.created_at
    ? new Date(tweet.created_at).toLocaleString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
    : ''
  const svg = {
    reply: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 12h8"/><path d="M12 8l-4 4 4 4"/></svg>',
    repost: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h13l-3-3"/><path d="M20 16H7l3 3"/></svg>',
    like: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 21s-8-5.5-8-11a4 4 0 0 1 7-2.6A4 4 0 0 1 20 10c0 5.5-8 11-8 11z"/></svg>',
    views: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="2.5"/></svg>'
  }
  const stats = []
  if (tweet.replies) stats.push(`<span class="st">${svg.reply}<span><b>${fmt(tweet.replies)}</b> 回复</span></span>`)
  if (tweet.retweets) stats.push(`<span class="st">${svg.repost}<span><b>${fmt(tweet.retweets)}</b> 转发</span></span>`)
  if (tweet.likes) stats.push(`<span class="st">${svg.like}<span><b>${fmt(tweet.likes)}</b> 喜欢</span></span>`)
  if (tweet.views) stats.push(`<span class="st">${svg.views}<span><b>${fmt(tweet.views)}</b> 浏览</span></span>`)
  const avatar = a.avatar_url ? `<img class="avatar" src="/img?u=${encodeURIComponent(a.avatar_url)}" alt="">` : '<div class="avatar">🧑</div>'
  const sens = tweet.possibly_sensitive ? '<p class="sens">⚠️ 该内容可能包含敏感内容</p>' : ''
  const textHtml = esc(tweet.text || '').replace(/(https?:\/\/[^\s<]+)/g, '<a class="tw-link" href="$1" target="_blank" rel="noopener">$1</a>')
  const gridCls = imgs.length === 1 ? 'single' : imgs.length === 3 ? 'triple' : ''
  const grid = (imgs.length || vids.length)
    ? `<div class="grid ${gridCls}">${vids.join('')}${imgs.join('')}</div>`
    : ''
  const resBlock = resRows.length
    ? `<div class="res"><h3>📦 资源直链 · 共 ${resRows.length} 个</h3>${resRows.join('')}<p class="res-tip">点击链接可预览/下载（经服务器代理），复制为原始直链</p></div>`
    : ''
  const comBlock = Array.isArray(comments)
    ? `<div class="com"><h3>💬 评论 ${comments.length} 条</h3>${comments.length ? comments.map(c => {
        const cav = c.avatar_url ? `<img class="com-av" src="/img?u=${encodeURIComponent(c.avatar_url)}" alt="" loading="lazy">` : '<div class="com-av">🧑</div>'
        const ct = c.created_at ? ` · ${new Date(c.created_at).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}` : ''
        return `<div class="com-row">${cav}<div class="com-b"><p class="com-u">${esc(c.name || c.screen_name || '')} <span>@${esc(c.screen_name || '')}</span></p><p class="com-t">${esc(c.text || '')}</p><p class="com-m">❤ ${fmt(c.likes)}${ct}</p></div></div>`
      }).join('') : '<p class="com-empty">暂无评论</p>'}</div>`
    : ''
  const verified = a.verified ? '<svg viewBox="0 0 24 24" width="15" height="15" fill="#1d9bf0"><path d="M22.5 12.5c0-1.58-.875-2.95-2.148-3.6.154-.435.238-.905.238-1.4 0-2.21-1.71-3.998-3.818-3.998-.47 0-.92.084-1.336.25C14.818 2.415 13.51 1.5 12 1.5s-2.816.917-3.437 2.25c-.415-.165-.866-.25-1.336-.25-2.11 0-3.818 1.79-3.818 4 0 .494.083.964.237 1.4-1.272.65-2.147 2.018-2.147 3.6 0 1.495.782 2.798 1.942 3.486-.02.17-.032.34-.032.514 0 2.21 1.708 4 3.818 4 .47 0 .92-.086 1.335-.25.62 1.334 1.926 2.25 3.437 2.25 1.512 0 2.818-.916 3.437-2.25.415.163.865.248 1.336.248 2.11 0 3.818-1.79 3.818-4 0-.174-.012-.344-.033-.513 1.158-.687 2.033-1.99 2.033-3.485z"/></svg>' : ''
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9D%95%8F%3C/text%3E%3C/svg%3E"><title>${esc(a.name || '推文')} (@${esc(a.screen_name || '')}) · X 解析</title><style>:root{--bg:#fff;--text:#0f1419;--dim:#536471;--line:#eff3f4;--link:#1d9bf0;--chip:#f7f9f9;--btn:#0f1419;--btn-t:#fff}@media(prefers-color-scheme:dark){:root{--bg:#000;--text:#e7e9ea;--dim:#71767b;--line:#2f3336;--chip:#16181c;--btn:#e7e9ea;--btn-t:#000}}*{margin:0;padding:0;box-sizing:border-box}body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,"PingFang SC","Microsoft YaHei",sans-serif}.wrap{max-width:600px;margin:0 auto;border-left:1px solid var(--line);border-right:1px solid var(--line);min-height:100vh}.top{position:sticky;top:0;background:rgba(255,255,255,.85);backdrop-filter:blur(12px);padding:10px 16px;font-size:17px;font-weight:700;border-bottom:1px solid var(--line);z-index:9;display:flex;align-items:center;gap:8px}@media(prefers-color-scheme:dark){.top{background:rgba(0,0,0,.85)}}.tw{display:flex;gap:12px;padding:14px 16px}.avatar{width:42px;height:42px;border-radius:50%;object-fit:cover;background:var(--chip);flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:20px}.b{flex:1;min-width:0}.uname{font-size:15px;font-weight:700;display:flex;align-items:center;gap:4px;flex-wrap:wrap}.uhandle{font-size:14px;color:var(--dim)}.utext{font-size:17px;line-height:1.5;white-space:pre-wrap;word-break:break-word;margin:8px 0}.tw-link{color:var(--link);text-decoration:none}.tw-link:hover{text-decoration:underline}.grid{display:grid;gap:2px;border-radius:16px;overflow:hidden;margin:10px 0;grid-template-columns:repeat(2,1fr);background:var(--line)}.grid.single{grid-template-columns:1fr}.grid.triple img:first-child{grid-row:span 2}.grid img{width:100%;height:100%;object-fit:cover;display:block;cursor:zoom-in}.grid video{grid-column:1/-1;width:100%;max-height:70vh;background:#000;display:block}.stats{display:flex;gap:22px;padding:10px 16px;border-bottom:1px solid var(--line);font-size:13px;color:var(--dim);flex-wrap:wrap}.st{display:flex;align-items:center;gap:5px}.st b{color:var(--text);font-weight:700}.sens{margin:0 16px;color:var(--dim);font-size:13px;background:var(--chip);border:1px solid var(--line);border-radius:12px;padding:10px 14px;margin-top:8px}.res{margin:14px 16px;background:var(--chip);border:1px solid var(--line);border-radius:16px;padding:14px}.res h3{font-size:15px;font-weight:700;margin-bottom:6px}.res-row{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--line);flex-wrap:wrap}.res-row:last-of-type{border-bottom:none}.res-ico{font-size:15px}.res-name{font-size:13px;color:var(--dim);white-space:nowrap}.res-link{font-size:12px;color:var(--link);word-break:break-all;flex:1;min-width:120px;text-decoration:none}.res-link:hover{text-decoration:underline}.res-copy{font-size:12px;border:1px solid var(--line);background:var(--bg);color:var(--text);border-radius:999px;padding:3px 10px;cursor:pointer;white-space:nowrap}.res-copy:hover{background:var(--chip)}.res-tip{margin-top:10px;font-size:11px;color:var(--dim)}.com{margin:14px 16px;background:var(--chip);border:1px solid var(--line);border-radius:16px;padding:14px}.com h3{font-size:15px;font-weight:700;margin-bottom:6px}.com-row{display:flex;gap:10px;padding:10px 0;border-bottom:1px solid var(--line)}.com-row:last-of-type{border-bottom:none}.com-av{width:36px;height:36px;border-radius:50%;object-fit:cover;background:var(--bg);flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:16px}.com-b{flex:1;min-width:0}.com-u{font-size:13px;font-weight:700}.com-u span{color:var(--dim);font-weight:400}.com-t{font-size:14px;line-height:1.5;white-space:pre-wrap;word-break:break-word;margin:3px 0}.com-m{font-size:12px;color:var(--dim)}.com-empty{font-size:13px;color:var(--dim)}.actions{padding:12px 16px;display:flex;gap:10px}.btn{flex:1;text-align:center;background:var(--btn);color:var(--btn-t);text-decoration:none;font-weight:700;font-size:15px;border-radius:999px;padding:10px 0}.btn.blue{background:#1d9bf0;color:#fff}.btn.blue:hover{background:#1a8cd8}.disc{padding:16px;font-size:12px;color:var(--dim);text-align:center;line-height:1.7}</style></head><body><div class="wrap"><div class="top"><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg> 推文</div><div class="tw">${avatar}<div class="b"><p class="uname">${esc(a.name || a.screen_name || '未知用户')}${verified}<span class="uhandle">@${esc(a.screen_name || '')}</span></p>${when ? `<p class="uhandle">${esc(when)}</p>` : ''}${sens}${tweet.text ? `<p class="utext">${textHtml}</p>` : ''}${grid}${stats.length ? `<div class="stats">${stats.join('')}</div>` : ''}</div></div>${comBlock}${resBlock}<div class="actions"><a class="btn blue" href="${esc(tweet.url || '#')}" target="_blank" rel="noopener">在 X 上查看</a></div><p class="disc">媒体经服务器代理加载，无法显示请开启 #X代理<br>页面 30 分钟内有效</p></div><script>function cp(el){var u=el.dataset.u||'';navigator.clipboard.writeText(u).then(function(){el.textContent='✅ 已复制';setTimeout(function(){el.textContent='📋 复制'},1500)}).catch(function(){prompt('复制直链：',u)})}</script></body></html>`
}
