import plugin from '../../../lib/plugins/plugin.js'
import * as proxy from '../components/proxy.js'
import { getConfig, setConfig } from '../components/config.js'

export class XProxy extends plugin {
  constructor () {
    super({
      name: 'X:代理',
      dsc: '订阅链接代理（v2ray 本地 socks5），供 X 解析/网页拉取走代理',
      event: 'message',
      priority: 2000,
      rule: [
        { reg: /^#?X代理(开|启用|on)$/i, fnc: 'proxyOn' },
        { reg: /^#?X代理(关|关闭|off)$/i, fnc: 'proxyOff' },
        { reg: /^#?X代理(状态|status)$/i, fnc: 'proxyStatus' },
        { reg: /^#?X代理(测试|test)$/i, fnc: 'proxyTest' },
        { reg: /^#?X代理(更新|刷新|订阅)$/i, fnc: 'proxyRefresh' },
        { reg: /^#?X代理(列表|节点列表)$/i, fnc: 'proxyList' },
        { reg: /^#?X代理节点\s*(\d+)$/i, fnc: 'proxyNode' },
        { reg: /^#?X代理设置订阅\s*(https?:\/\/\S+)$/i, fnc: 'proxySetSub' }
      ]
    })
  }

  async proxyOn (e) {
    if (!e.isMaster) return e.reply('❌ 仅主人可用')
    try {
      const r = await proxy.startProxy()
      const n = r.node
      const lines = [
        `✅ 代理已启动${r.ok ? '' : '，但连通测试失败'}`,
        `🖥 节点 #${r.node.idx ?? getConfig().proxy.nodeIndex} ${n.name}`,
        `🌐 ${n.add}:${n.port} [${n.type}/${n.net}${n.tls ? '/tls' : ''}]`,
        `🔌 本地 socks5 127.0.0.1:${getConfig().proxy.port}`
      ]
      if (!r.ok) lines.push(`⚠️ 测试失败：${r.error || '未知错误'}`)
      return e.reply(lines.join('\n'))
    } catch (err) {
      return e.reply(`❌ 代理启动失败：${err.message}`)
    }
  }

  async proxyOff (e) {
    if (!e.isMaster) return e.reply('❌ 仅主人可用')
    proxy.stopProxy()
    return e.reply('🛑 代理已停止')
  }

  async proxyStatus (e) {
    if (!e.isMaster) return e.reply('❌ 仅主人可用')
    const s = proxy.getStatus()
    const lines = [
      `🔌 代理状态${s.running ? '：运行中 ✅' : '：未运行 ⛔'}`,
      `📡 订阅：${s.subscribeUrl || '未配置（#X代理设置订阅 <链接>）'}`
    ]
    if (s.running && s.node) {
      const n = s.node
      lines.push(`🖥 当前节点 #${n.idx} ${n.name}（${n.add}:${n.port} [${n.type}/${n.net}]）`)
    }
    lines.push(`📚 节点总数：${s.nodeCount}`)
    return e.reply(lines.join('\n'))
  }

  async proxyTest (e) {
    if (!e.isMaster) return e.reply('❌ 仅主人可用')
    if (!proxy.getStatus().running) {
      return e.reply('❌ 代理未运行，请先 #X代理开')
    }
    const ok = await proxy.testProxy()
    return e.reply(ok
      ? '✅ 当前节点连通正常'
      : `❌ 当前节点测试失败：${proxy.getStatus().node?.name || ''} ${proxy.getStatus().running ? '' : ''}`)
  }

  async proxyRefresh (e) {
    if (!e.isMaster) return e.reply('❌ 仅主人可用')
    try {
      const nodes = await proxy.refreshNodes()
      return e.reply(`✅ 订阅已更新，共 ${nodes.length} 个节点\n第一条：${nodes[0]?.name || ''}`)
    } catch (err) {
      return e.reply(`❌ 订阅更新失败：${err.message}`)
    }
  }

  async proxyList (e) {
    if (!e.isMaster) return e.reply('❌ 仅主人可用')
    const nodes = proxy.getNodes()
    if (!nodes.length) return e.reply('暂无节点，先 #X代理更新 拉取订阅')
    const lines = nodes.map((n, i) => `${i}. ${n.name}（${n.add}:${n.port} [${n.type}/${n.net}${n.tls ? '/tls' : ''}]）`)
    return e.reply(`📚 订阅节点（${nodes.length}）:\n${lines.join('\n')}\n💡 切换：#X代理节点 <序号>`)
  }

  async proxyNode (e) {
    if (!e.isMaster) return e.reply('❌ 仅主人可用')
    const idx = Number(e.match[1])
    const nodes = proxy.getNodes()
    if (!nodes[idx]) return e.reply(`❌ 节点 #${idx} 不存在（共 ${nodes.length} 个）`)
    try {
      const r = await proxy.startProxy({ nodeIndex: idx })
      const n = r.node
      return e.reply(`✅ 已切换到节点 #${idx} ${n.name}${r.ok ? '' : '，但连通测试失败：' + (r.error || '')}`)
    } catch (err) {
      return e.reply(`❌ 切换失败：${err.message}`)
    }
  }

  async proxySetSub (e) {
    if (!e.isMaster) return e.reply('❌ 仅主人可设置订阅链接')
    const url = e.match[1]
    setConfig({ proxy: { subscribeUrl: url } })
    try {
      const nodes = await proxy.refreshNodes()
      return e.reply(`✅ 订阅链接已保存，解析到 ${nodes.length} 个节点\n#X代理开 启动代理`)
    } catch (err) {
      return e.reply(`✅ 订阅链接已保存\n⚠️ 但解析失败：${err.message}`)
    }
  }
}
