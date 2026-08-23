import plugin from '../../../lib/plugins/plugin.js'
import { fetchText } from '../components/fetch.js'
import { getConfig } from '../components/config.js'
import { getStatus } from '../components/proxy.js'
import { extractXUrl, getTweet, buildXMessage } from '../components/x.js'

const MEDIA_EXT = /\.(mp4|webm|mov|mkv|avi|gif|jpg|jpeg|png|webp|bmp|mp3|m4a|flac|wav)(\?|#|$)/i

export class XPull extends plugin {
  constructor () {
    super({
      name: 'X:网页拉取',
      dsc: '拉取网页内容，返回页面标题/描述与资源链接（类 MApull）',
      event: 'message',
      priority: 2000,
      rule: [
        { reg: /^#?X拉取\s*(https?:\/\/\S+)/i, fnc: 'pull' },
        { reg: /^#?拉取网页\s*(https?:\/\/\S+)/i, fnc: 'pull' }
      ]
    })
  }

  async pull (e) {
    const url = (e.msg.match(/(?:#?X拉取|#?拉取网页)\s*(https?:\/\/\S+)/i) || [])[1] || e.match?.[1]
    if (!url) return e.reply('❌ 请提供网页链接')

    // X链接走解析
    const xInfo = extractXUrl(url)
    if (xInfo) {
      try {
        const { source, tweet } = await getTweet(xInfo)
        return e.reply(buildXMessage(tweet, source))
      } catch (err) {
        return e.reply(`❌ X 解析失败：${err.message}`)
      }
    }

    const cfg = getConfig()
    const timeout = cfg.pull.timeout
    const errors = []

    // 直连
    try {
      const res = await fetchText(url, { timeout })
      return await this.report(e, url, res)
    } catch (err) {
      errors.push(err.message)
    }

    // 代理回退
    if (getStatus().enabled) {
      try {
        const res = await fetchText(url, { proxy: true, timeout })
        return await this.report(e, url, res, '（经代理）')
      } catch (err) {
        errors.push(`代理: ${err.message}`)
      }
    } else {
      errors.push('（可 #X代理开 启用代理后重试）')
    }

    return e.reply(`❌ 拉取失败：${errors.join('；')}`)
  }

  async report (e, url, res, tag = '') {
    const cfg = getConfig()
    const type = (res.contentType || '').toLowerCase()

    // 直接媒体资源
    if (/^(image|video|audio)\//.test(type) || MEDIA_EXT.test(url)) {
      const kind = type.startsWith('image/') ? '🖼 图片' : type.startsWith('video/') ? '🎬 视频' : type.startsWith('audio/') ? '🎵 音频' : '📦 媒体'
      const size = res.contentLength ? ` (${this.fmtSize(res.contentLength)})` : ''
      const lines = [
        `🕸 网页拉取${tag}`,
        `🔗 ${url}`,
        `${kind}${size}: ${type || '未知类型'}`,
        '━━━━━━━━━━━━',
        `✅ 直链状态 HTTP ${res.status}`,
        url
      ]
      return e.reply(lines.join('\n'))
    }

    // HTML 页面
    const lines = []
    lines.push(`🕸 网页拉取${tag}`)
    lines.push(`🔗 ${res.url || url}`)
    const title = this.extractTitle(res.body)
    if (title) lines.push(`📰 ${title}`)
    const desc = this.extractDescription(res.body)
    if (desc) lines.push(`📝 ${desc}`)
    lines.push('━━━━━━━━━━━━')

    const { videos, images, mediaLinks } = this.extractResources(res.body, res.url || url)
    let count = 0
    if (videos.length) {
      lines.push('🎬 视频资源:')
      for (const v of videos.slice(0, cfg.pull.maxLinks)) { lines.push(v); count++ }
    }
    if (images.length) {
      lines.push('🖼 图片资源:')
      for (const img of images.slice(0, cfg.pull.maxLinks)) { lines.push(img); count++ }
    }
    if (mediaLinks.length) {
      lines.push('📎 媒体文件:')
      for (const m of mediaLinks.slice(0, cfg.pull.maxLinks)) { lines.push(m); count++ }
    }
    if (!count) lines.push('（页面内未发现视频/图片资源）')
    lines.push('━━━━━━━━━━━━')
    lines.push(`✅ 页面抓取成功 HTTP ${res.status}，正文 ${(res.body || '').length} 字符`)

    // 控制总长度
    const msg = lines.join('\n')
    return e.reply(msg.length > cfg.pull.maxText ? `${msg.slice(0, cfg.pull.maxText)}…` : msg)
  }

  extractTitle (html) {
    const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i)
    return m ? this.clean(m[1]).slice(0, 120) : ''
  }

  extractDescription (html) {
    const m = String(html || '').match(/<meta[^>]+(?:name|property)=["'](?:og:description|description)["'][^>]+content=["']([^"']+)["']/i) ||
              String(html || '').match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["'](?:og:description|description)["']/i)
    return m ? this.clean(m[1]).slice(0, 200) : ''
  }

  extractResources (html, base) {
    const videos = []
    const images = []
    const mediaLinks = []
    const seen = new Set()
    const abs = (ref) => {
      try { return new URL(ref, base).href } catch { return ref }
    }
    const push = (arr, u) => {
      u = abs(u)
      if (!/^https?:\/\//i.test(u)) return
      if (seen.has(u)) return
      seen.add(u)
      arr.push(u)
    }
    const body = String(html || '')
    // 视频标签
    for (const m of body.matchAll(/<video[^>]+src=["']([^"']+)["']/gi)) push(videos, m[1])
    for (const m of body.matchAll(/<source[^>]+src=["']([^"']+)["'][^>]*type=["']video[^"']*["']/gi)) push(videos, m[1])
    for (const m of body.matchAll(/<source[^>]+type=["']video[^"']*["'][^>]*src=["']([^"']+)["']/gi)) push(videos, m[1])
    // 图片标签
    for (const m of body.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) push(images, m[1])
    for (const m of body.matchAll(/<img[^>]+data-src=["']([^"']+)["']/gi)) push(images, m[1])
    // 媒体链接
    for (const m of body.matchAll(/<a[^>]+href=["']([^"']+)["']/gi)) {
      if (MEDIA_EXT.test(m[1])) push(mediaLinks, m[1])
    }
    return { videos, images, mediaLinks }
  }

  clean (s) {
    return String(s || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  fmtSize (len) {
    const n = Number(len || 0)
    if (!n) return ''
    if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`
    if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`
    return `${n}B`
  }
}
