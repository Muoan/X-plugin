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
      `🌐 地址: http://111.170.175.22:${port}`,
      `🔑 token: ${panel.getToken()}`,
      `📚 订阅节点: ${nodeCount} 个`,
      '💡 提示: 微信/QQ 内打不开就复制到浏览器访问'
    ]
    return e.reply(lines.join('\n'))
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
