import os from 'node:os'
import plugin from '../../../lib/plugins/plugin.js'
import * as panel from '../components/panel.js'
import * as proxy from '../components/proxy.js'
import { getConfig, setConfig } from '../components/config.js'

export class XPanel extends plugin {
  constructor () {
    super({
      name: 'X:面板',
      dsc: 'X-plugin Web 面板（类 MApull）',
      event: 'message',
      priority: 2000,
      rule: [
        { reg: /^#?X面板(状态|地址)?$/i, fnc: 'panelStatus' },
        { reg: /^#?X面板重置(token|令牌)$/i, fnc: 'panelResetToken' },
        { reg: /^#?X面板端口\s*(\d+)$/i, fnc: 'panelPort' }
      ]
    })
  }

  async panelStatus (e) {
    if (!e.isMaster) return e.reply('❌ 仅主人可用')
    const cfg = getConfig()
    const port = cfg.panel?.port || 3007
    const nodeCount = proxy.getNodes().length
    const lines = [
      '🖥 X 资源解析面板',
      `🔑 token: ${panel.getToken()}`,
      `📚 订阅节点: ${nodeCount} 个`,
      '💡 提示: 微信/QQ 内打不开就复制到浏览器访问'
    ]
    for (const ip of getLocalIps()) lines.push(`🌐 内网: http://${ip}:${port}`)
    e.reply(lines.join('\n'))
    // 公网异步补发（仿 YePanel 国内源优先）
    getRemoteIp().then((ip) => {
      if (ip) e.reply(`🌐 公网: http://${ip}:${port}`)
    })
    return true
  }

  async panelResetToken (e) {
    if (!e.isMaster) return e.reply('❌ 仅主人可重置 token')
    const token = panel.resetToken()
    return e.reply(`✅ 面板 token 已重置: ${token}\n请用新 token 登录面板`)
  }

  async panelPort (e) {
    if (!e.isMaster) return e.reply('❌ 仅主人可修改端口')
    const port = Number(e.match[1])
    if (port < 1 || port > 65535) return e.reply('❌ 端口不合法')
    setConfig({ panel: { port } })
    panel.stop()
    panel.start()
    return e.reply(`✅ 面板端口已改为 ${port}，已自动重启面板`)
  }
}

/** 本机 IPv4 */
function getLocalIps () {
  const list = []
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos || []) {
      if (info.family === 'IPv4' && !info.internal) list.push(info.address)
    }
  }
  return list
}

/** 公网 IP（仿 YePanel：国内源优先，逐个尝试） */
async function getRemoteIp () {
  const providers = [
    { api: 'https://v4.ip.zxinc.org/info.php?type=json', key: 'data.myip' },
    { api: 'https://ipinfo.io/json', key: 'ip' },
    { api: 'https://api.ipify.org', key: null }
  ]
  for (const p of providers) {
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 4000)
      const res = await fetch(p.api, { signal: ctrl.signal })
      clearTimeout(timer)
      if (!res.ok) continue
      let ip = ''
      if (p.key) {
        const json = await res.json()
        ip = String(p.key.split('.').reduce((prev, curr) => prev && prev[curr], json) || '').trim()
      } else {
        ip = (await res.text()).trim()
      }
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip
    } catch { /* 换下一个 */ }
  }
  return ''
}
