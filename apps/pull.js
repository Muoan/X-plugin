import plugin from '../../../lib/plugins/plugin.js'
import { fetchText } from '../components/fetch.js'
import { getConfig } from '../components/config.js'
import { getStatus } from '../components/proxy.js'
import { extractXUrl, getTweet, renderTweetHtml } from '../components/x.js'
import * as panel from '../components/panel.js'

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

    // X链接走解析渲染
    const xInfo = extractXUrl(url)
    if (xInfo) {
      try {
        const { source, tweet } = await getTweet(xInfo)
        const id = panel.renderPage(renderTweetHtml(tweet))
        return e.reply(`📄 已拉取推文${source === 'proxy' ? '（经代理）' : ''}\n🔗 查看页面：${panel.renderLink(id)}\n⏳ 页面 1 小时内有效`)
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

    // HTML 页面 → 渲染页直链
    const title = this.extractTitle(res.body)
    const desc = this.extractDescription(res.body)
    const { videos, images, mediaLinks } = this.extractResources(res.body, res.url || url)
    const id = panel.renderPage(renderWebHtml({ url: res.url || url, title, desc, videos, images, mediaLinks, maxLinks: cfg.pull.maxLinks }))
    return e.reply(`🕸 网页拉取${tag}完成${title ? `「${title}」` : ''}\n🔗 查看页面：${panel.renderLink(id)}\n⏳ 页面 1 小时内有效`)
  }

  /** 网页渲染页模板 */
  renderWebHtml ({ url, title, desc, videos, images, mediaLinks, maxLinks }) {
    const esc = (s) => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
    const links = (arr, icon) => {
      const list = (arr || []).slice(0, maxLinks || 10)
      if (!list.length) return ''
      return `<p class="sec">${icon} ${list.length} 个</p>` + list.map(u => `<a class="res" href="${esc(u)}">${esc(u.length > 80 ? u.slice(0, 80) + '…' : u)}</a>`).join('')
    }
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title || '网页拉取')} · X 拉取</title><style>*{margin:0;padding:0;box-sizing:border-box}body{min-height:100vh;background:linear-gradient(160deg,#0f172a,#1e293b);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;padding:20px;display:flex;justify-content:center}.card{background:#fff;border-radius:16px;box-shadow:0 8px 30px rgba(37,99,235,.12);padding:24px;max-width:560px;width:100%;border-top:4px solid #2563eb;margin:auto}.hd h1{font-size:18px;color:#1e3a8a;font-weight:700;line-height:1.5;word-break:break-word}.url{font-size:12px;color:#64748b;margin:6px 0 14px;word-break:break-all}.desc{font-size:14px;color:#475569;line-height:1.7;background:#f8fafc;border-radius:10px;padding:12px;margin-bottom:14px;word-break:break-word}.sec{font-size:14px;color:#1e293b;font-weight:700;margin:12px 0 6px}.res{display:block;font-size:12px;color:#2563eb;background:#eff6ff;border-radius:8px;padding:8px 12px;margin-bottom:6px;text-decoration:none;word-break:break-all}.res:hover{background:#dbeafe}.none{font-size:13px;color:#94a3b8;padding:8px 0}.disc{font-size:11px;color:#94a3b8;text-align:center;margin-top:14px;line-height:1.7}</style></head><body><div class="card"><div class="hd"><h1>${esc(title || '（无标题）')}</h1></div><p class="url">${esc(url)}</p>${desc ? `<div class="desc">${esc(desc)}</div>` : ''}${links(videos, '🎬 视频资源')}${links(images, '🖼 图片资源')}${links(mediaLinks, '📎 媒体文件')}${(!videos || !videos.length) && (!images || !images.length) && (!mediaLinks || !mediaLinks.length) ? '<p class="none">页面内未发现视频/图片资源</p>' : ''}<p class="disc">页面 1 小时内有效</p></div></body></html>`
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
