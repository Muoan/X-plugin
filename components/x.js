import { fetchText } from './fetch.js'
import { getConfig } from './config.js'
import { getStatus } from './proxy.js'

const X_REG = /(?:https?:\/\/)?(?:www\.|mobile\.|m\.)?(?:x|twitter)\.com\/(?:#!\/)?([A-Za-z0-9_]{1,20})\/status\/(\d+)/i

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

/** 推文渲染页模板 */
export function renderTweetHtml (tweet) {
  const a = tweet.author || {}
  const esc = (s) => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const fmt = (n) => n >= 1000000 ? (n / 1000000).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n || 0)
  const media = tweet.media || {}
  const imgs = (media.photos || []).map(ph => `<img src="/img?u=${encodeURIComponent(ph.url)}" alt="photo" loading="lazy">`).join('')
  const vids = (media.videos || []).map(v => `<video controls preload="metadata" src="/img?u=${encodeURIComponent(v.url)}" poster="/img?u=${encodeURIComponent(v.thumbnail_url || '')}"></video>`).join('')
  const when = tweet.created_at ? new Date(tweet.created_at).toLocaleString('zh-CN', { hour12: false }) : ''
  const stats = []
  if (tweet.views) stats.push(`👀 ${fmt(tweet.views)}`)
  if (tweet.likes) stats.push(`👍 ${fmt(tweet.likes)}`)
  if (tweet.retweets) stats.push(`🔁 ${fmt(tweet.retweets)}`)
  if (tweet.replies) stats.push(`💬 ${fmt(tweet.replies)}`)
  const avatar = a.avatar_url ? `<img class="avatar" src="/img?u=${encodeURIComponent(a.avatar_url)}" alt="">` : '<div class="avatar">🧑</div>'
  const sens = tweet.possibly_sensitive ? '<p class="sens">⚠️ 该推文可能包含敏感内容</p>' : ''
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(a.name || '推文')} · X 解析</title><style>*{margin:0;padding:0;box-sizing:border-box}body{min-height:100vh;background:linear-gradient(160deg,#0f172a,#1e293b);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;padding:20px;display:flex;justify-content:center}.card{background:#fff;border-radius:16px;box-shadow:0 8px 30px rgba(37,99,235,.12);padding:24px;max-width:560px;width:100%;border-top:4px solid #2563eb;margin:auto}.head{display:flex;align-items:center;gap:12px;margin-bottom:14px}.avatar{width:48px;height:48px;border-radius:50%;object-fit:cover;background:#eef4ff;display:flex;align-items:center;justify-content:center;font-size:22px}.name{font-size:16px;color:#1e293b;font-weight:700}.handle{font-size:13px;color:#64748b}.when{font-size:12px;color:#94a3b8;margin-top:2px}.text{font-size:15px;color:#1e293b;line-height:1.7;white-space:pre-wrap;word-break:break-word;background:#f8fafc;border-radius:10px;padding:14px;margin-bottom:14px}.sens{color:#b45309;font-size:13px;background:#fffbeb;border-radius:8px;padding:8px 12px;margin-bottom:12px}.grid{display:grid;grid-template-columns:1fr;gap:10px;margin-bottom:12px}.grid img{width:100%;border-radius:10px;display:block;background:#f1f5f9}.grid video{width:100%;border-radius:10px;background:#000;max-height:70vh}.stats{display:flex;gap:16px;color:#64748b;font-size:13px;margin-bottom:14px;flex-wrap:wrap}.stats span{background:#f1f5f9;border-radius:999px;padding:4px 12px}.link{display:block;text-align:center;background:#2563eb;color:#fff;text-decoration:none;font-weight:600;font-size:14px;border-radius:10px;padding:12px;margin-bottom:12px}.link:hover{background:#1d4ed8}.disc{font-size:11px;color:#94a3b8;text-align:center;line-height:1.7}</style></head><body><div class="card"><div class="head">${avatar}<div><p class="name">${esc(a.name || a.screen_name || '未知用户')}</p><p class="handle">@${esc(a.screen_name || '')}${when ? ' · ' + esc(when) : ''}</p></div></div>${sens}${tweet.text ? `<div class="text">${esc(tweet.text)}</div>` : ''}${imgs ? `<div class="grid">${imgs}</div>` : ''}${vids ? `<div class="grid">${vids}</div>` : ''}${stats.length ? `<div class="stats">${stats.map(s => `<span>${s}</span>`).join('')}</div>` : ''}<a class="link" href="${esc(tweet.url || '#')}" target="_blank" rel="noopener">🔗 查看原文</a><p class="disc">媒体经服务器代理加载，无法显示请开启 #X代理<br>页面 1 小时内有效</p></div></body></html>`
}
