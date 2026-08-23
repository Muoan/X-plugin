import plugin from '../../../lib/plugins/plugin.js'
import path from 'node:path'
import { extractXUrl, getTweet, buildXMessage } from '../components/x.js'
import { getConfig, setConfig } from '../components/config.js'
import * as downloader from '../components/downloader.js'
import * as panel from '../components/panel.js'

/** 挑最佳资源 */
function pickDownloadUrl (tweet) {
  const media = tweet.media?.all || []
  for (const item of media) {
    if (item.type === 'video' || item.type === 'gif') {
      const variants = (item.variants || [])
        .filter(v => (v.content_type || '').includes('mp4'))
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))
      if (variants[0]?.url) return { url: variants[0].url, kind: item.type === 'gif' ? 'GIF' : '视频' }
    }
  }
  for (const item of media) {
    if (item.type === 'image' && item.url) return { url: item.url, kind: '图片' }
  }
  return null
}

function fmtSize (n) {
  return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(0) + ' KB' : n + ' B'
}

export class XResource extends plugin {
  constructor () {
    super({
      name: 'X:资源解析',
      dsc: '解析 X/Twitter 推文链接中的视频/图片/GIF，自动下载并以直链分享',
      event: 'message',
      priority: 2000,
      rule: [
        { reg: /(?:https?:\/\/)?(?:www\.|mobile\.|m\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]+\/status\/\d+/i, fnc: 'autoParse' },
        { reg: /^#?X解析\s*(?:https?:\/\/)?\S+/i, fnc: 'cmdParse' },
        { reg: /^#?X下载\s*\S+/i, fnc: 'cmdDownload' },
        { reg: /^#?X自动下载\s*(开|关)/i, fnc: 'toggleAuto' }
      ]
    })
  }

  async autoParse (e) {
    // 自动下载
    const cfg = getConfig()
    if (cfg.x.autoDownload === false) {
      await this.doParse(e, e.msg)
      return true
    }
    await e.reply('🔍 识别到 X 链接，正在解析并下载，请稍候…')
    const info = extractXUrl(e.msg)
    if (!info) return true
    try {
      const { source, tweet } = await getTweet(info)
      const base = buildXMessage(tweet, source)
      const pick = pickDownloadUrl(tweet)
      if (!pick) return e.reply(base)
      const r = await downloader.downloadFile(pick.url, { maxMB: cfg.panel?.maxFileMB || 500 })
      const { key, ttlMin } = panel.createFileKey(r.id)
      return e.reply(`${base}

━━━━━━━━━━━━
📥 已自动下载${pick.kind}（${fmtSize(r.size)}）
🔗 直链: ${panel.downloadLink(r.id, key)}
🔎 验证/预览页: ${panel.fileLink(r.id)}
⏳ ${ttlMin} 分钟内有效，过期自动删除
📴 关闭自动下载: #X自动下载关`)
    } catch (err) {
      return e.reply(`❌ 自动下载失败：${err.message}\n可用 #X解析 查看资源直链，或 #X下载 重试`)
    }
  }

  async toggleAuto (e) {
    const on = /开/.test(e.msg)
    setConfig({ x: { autoDownload: on } })
    return e.reply(on ? '✅ 已开启自动下载：发 X 链接将自动下载并分享直链' : '✅ 已关闭自动下载：发 X 链接仅解析资源直链')
  }

  async cmdParse (e) {
    await this.doParse(e, e.msg.replace(/^#?X解析\s*/i, ''))
    return true
  }

  async cmdDownload (e) {
    const url = e.msg.replace(/^#?X下载\s*/i, '').trim()
    const cfg = getConfig()
    await e.reply('⏳ 正在下载资源到服务器，请稍候…')
    try {
      let dlUrl
      let kind = '资源'
      const info = extractXUrl(url)
      if (info) {
        const { tweet } = await getTweet(info)
        const pick = pickDownloadUrl(tweet)
        if (!pick) return e.reply('❌ 该推文没有可下载的视频/图片资源')
        dlUrl = pick.url
        kind = pick.kind
      } else if (/^https?:\/\/\S+$/i.test(url)) {
        dlUrl = url
      } else {
        return e.reply('❌ 请提供 X 推文链接或文件直链')
      }

      const r = await downloader.downloadFile(dlUrl, { maxMB: cfg.panel?.maxFileMB || 500 })
      const { key, ttlMin } = panel.createFileKey(r.id)
      const lines = [
        `📥 ${kind}下载完成`,
        `📄 文件名: ${path.basename(r.path)}`,
        `💾 大小: ${(r.size / 1048576).toFixed(1)} MB`,
        `🔗 直链: ${panel.downloadLink(r.id, key)}`,
        `🔎 验证/预览页: ${panel.fileLink(r.id)}`,
        `⏳ 直链 ${ttlMin} 分钟内有效，过期自动删除`
      ]
      return e.reply(lines.join('\n'))
    } catch (err) {
      return e.reply(`❌ ${err.message}`)
    }
  }

  async doParse (e, text) {
    const info = extractXUrl(text)
    if (!info) {
      return e.reply('未识别到 X/Twitter 链接，格式：x.com/用户名/status/推文ID')
    }
    try {
      const { source, tweet } = await getTweet(info)
      return e.reply(buildXMessage(tweet, source))
    } catch (err) {
      return e.reply(`❌ 解析失败：${err.message}`)
    }
  }
}
