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
