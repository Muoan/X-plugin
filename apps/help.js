import plugin from '../../../lib/plugins/plugin.js'
import { helpCfg, helpList } from '../config/help.js'

export class XHelp extends plugin {
  constructor () {
    super({
      name: 'X:帮助',
      dsc: 'X-plugin 帮助菜单（图片渲染）',
      event: 'message',
      priority: 2000,
      rule: [
        { reg: /^#?X(帮助|help|菜单)$/i, fnc: 'help' }
      ]
    })
  }

  async help (e) {
    // 优先图片渲染
    try {
      if (e.runtime?.render) {
        const layoutPath = process.cwd() + '/plugins/X-plugin/resources/common/layout/'
        const colCount = Math.min(4, Math.max(2, parseInt(helpCfg.colCount) || 3))
        return await e.runtime.render('X-plugin', 'help/index', {
          helpCfg,
          helpGroup: helpList,
          colCount,
          copyright: 'Created By Trss-Yunzai &amp; X-plugin',
          pageGotoParams: { waitUntil: 'networkidle2' }
        }, {
          beforeRender ({ data }) {
            data.defaultLayout = layoutPath + 'default.html'
            data._layout_path = layoutPath
            data.sys.scale = 'style="transform:scale(1.6)"'
            return data
          }
        })
      }
    } catch (err) {
      logger?.error?.('[X-plugin] 帮助图片渲染失败，回退文字：', err)
    }

    // 纯文字兜底
    const lines = ['📱 X 解析 · 帮助', '━━━━━━━━━━━━']
    for (const g of helpList) {
      lines.push(`\n【${g.group}】`)
      for (const h of g.list) lines.push(`· ${h.title} — ${h.desc}`)
    }
    lines.push('━━━━━━━━━━━━\n💡 提示：video.twimg.com / pbs.twimg.com 直链国内直连可能打不开，可开启代理')
    return e.reply(lines.join('\n'))
  }
}
