import plugin from '../../../lib/plugins/plugin.js'
import path from 'node:path'
import { extractXUrl, getTweet, buildXMessage, pickDownloadUrls, renderTweetHtml, getComments, checkCookie } from '../components/x.js'
import { getConfig, setConfig } from '../components/config.js'
import * as downloader from '../components/downloader.js'
import * as proxy from '../components/proxy.js'
import * as panel from '../components/panel.js'

/** 批量下载 */
async function downloadAll (picks, maxMB) {
  const results = []
  for (const pick of picks) {
    try {
      const r = await downloader.downloadFile(pick.url, { maxMB })
      const { key, ttlMin } = panel.createFileKey(r.id)
      results.push({ pick, r, key, ttlMin })
    } catch (err) {
      results.push({ pick, err: err.message })
    }
  }
  return results
}

/** 拼下载结果文案 */
async function buildDownloadMsg (results, srcUrl = '') {
  const ok = results.filter(r => !r.err)
  if (results.length > 1 && ok.length) {
    const t = panel.addFinishedTask({
      url: srcUrl || results[0].pick.url,
      kind: ok[0].pick.kind,
      name: ok[0].pick.author || '',
      files: results.map(it => it.err
        ? { url: it.pick.url, kind: it.pick.kind, error: it.err }
        : { url: it.pick.url, kind: it.pick.kind, file_id: it.r.id, file_name: path.basename(it.r.path), file_path: it.r.path, file_size: it.r.size })
    })
    return `📥 已下载 ${ok.length}/${results.length} 个资源\n🔗 综合链接：${panel.shareLink(t.code)}\n打开后每个资源一个分链接，点击即下载\n⏳ 链接 ${ok[0]?.ttlMin || 60} 分钟内有效，过期自动删除`
  }
  const lines = [`📥 已下载 ${ok.length}/${results.length} 个资源`]
  results.forEach((it, i) => {
    if (it.err) lines.push(`${i + 1}️⃣ ${it.pick.kind} 失败：${it.err}`)
    else lines.push(`${i + 1}️⃣ ${it.pick.kind}（${fmtSize(it.r.size)}）\n🔗 ${panel.downloadLink(it.r.id, it.key)}`)
  })
  lines.push(`⏳ 直链 ${ok[0]?.ttlMin || 60} 分钟内有效，过期自动删除`)
  return lines.join('\n')
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
        { reg: /^#?X自动下载\s*(开|关)/i, fnc: 'toggleAuto' },
        { reg: /^#?X设置Cookie\s*\S+/i, fnc: 'cmdSetCookie' },
        { reg: /^#?X删除Cookie/i, fnc: 'cmdDelCookie' },
        { reg: /^#?X检查Cookie/i, fnc: 'cmdCheckCookie' }
      ]
    })
  }

  async autoParse (e) {
    // 命令消息交给对应命令，不自动下载
    if (/^#?X(?:解析|下载|自动下载)/i.test(e.msg)) return false
    // 自动下载
    const cfg = getConfig()
    if (cfg.x.autoDownload === false) {
      // 自动下载关闭时自动执行解析任务（渲染页直链）
      return this.cmdParse(e)
    }
    await e.reply('🔍 识别到 X 链接，正在解析并下载，请稍候…')
    const info = extractXUrl(e.msg)
    if (!info) return true
    try {
      const { source, tweet } = await getTweet(info)
      const base = buildXMessage(tweet, source)
      const picks = pickDownloadUrls(tweet)
      if (!picks.length) return e.reply(base)
      const results = await downloadAll(picks, cfg.panel?.maxFileMB || 500)
      return e.reply(`${base}

━━━━━━━━━━━━
${await buildDownloadMsg(results, info.url)}
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

  async cmdSetCookie (e) {
    if (!e.isMaster) return e.reply('❌ 仅主人可用')
    const val = e.msg.replace(/^#?X设置Cookie\s*/i, '').trim()
    if (!val) return e.reply('格式：#X设置Cookie auth_token=xxx; ct0=yyy（或整条 Cookie 串）')
    setConfig({ x: { cookie: val } })
    return e.reply(`✅ 已保存 X Cookie（${val.length} 字符）\n⚠️ 解析时自动抓取评论，请使用小号 Cookie，谨防封号`)
  }

  async cmdDelCookie (e) {
    if (!e.isMaster) return e.reply('❌ 仅主人可用')
    setConfig({ x: { cookie: '' } })
    return e.reply('✅ 已删除 X Cookie，解析将不再抓取评论')
  }

  async cmdCheckCookie (e) {
    if (!e.isMaster) return e.reply('❌ 仅主人可用')
    const ck = getConfig().x?.cookie || ''
    if (!ck) return e.reply('未配置 Cookie，请先 #X设置Cookie')
    // 起代理再检查
    let autoStarted = false
    try {
      autoStarted = await downloader.ensureProxy(true, 'parse')
    } catch { /* 代理失败也继续尝试 */ }
    try {
      const r = await checkCookie(ck)
      return e.reply(r.msg)
    } finally {
      if (autoStarted) { try { await downloader.stopProxy('parse') } catch { /* ignore */ } }
    }
  }

  async cmdParse (e) {
    const text = e.msg.replace(/^#?X解析\s*/i, '').trim()
    const info = extractXUrl(text)
    if (!info) return e.reply('未识别到 X/Twitter 链接，格式：x.com/用户名/status/推文ID')
    await e.reply('🔍 正在解析，请稍候…')
    let autoStarted = false
    try {
      // 解析走代理更稳，用完即关
      autoStarted = await downloader.ensureProxy(true, 'parse')
      const { source, tweet } = await getTweet(info)
      // 配置了 Cookie 则附带抓取评论
      let comments
      const ck = getConfig().x?.cookie || ''
      if (ck) {
        try {
          comments = await getComments(info.id, ck)
        } catch { /* 评论失败不影响主流程 */ }
      }
      const id = panel.renderPage(renderTweetHtml(tweet, comments), info.url)
      return e.reply(`📄 解析完成${source === 'proxy' ? '（经代理）' : ''}${comments ? `，已抓取 ${comments.length} 条评论` : ''}\n🔗 查看页面：${panel.renderLink(id)}\n⏳ 页面 1 小时内有效`)
    } catch (err) {
      return e.reply(`❌ 解析失败：${err.message}`)
    } finally {
      // 本次启动的才关，不干扰下载/手动代理
      if (autoStarted) proxy.stopProxy('parse')
    }
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
        const picks = pickDownloadUrls(tweet)
        if (!picks.length) return e.reply('❌ 该推文没有可下载的视频/图片资源')
        const results = await downloadAll(picks, cfg.panel?.maxFileMB || 500)
        return e.reply(await buildDownloadMsg(results, info.url))
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

}
