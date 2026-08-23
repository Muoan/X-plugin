export const helpCfg = {
  title: 'X 解析 · 帮助',
  subTitle: 'Trss-Yunzai & X-plugin',
  colCount: 3,
  colWidth: 265
}

export const helpList = [
  {
    group: '🎬 X 资源解析',
    list: [
      { emoji: '🔗', title: '自动解析下载', desc: '群里直接发 x.com / twitter.com 链接，自动下载并分享直链' },
      { emoji: '🎯', title: '#X解析 <链接>', desc: '仅解析，返回全部资源直链' },
      { emoji: '📥', title: '#X下载 <链接>', desc: '手动下载到服务器生成直链' },
      { emoji: '📴', title: '#X自动下载 开/关', desc: '切换发链接是否自动下载' },
      { emoji: '🎞️', title: '视频/图片/GIF', desc: '自动提取全部资源直链' },
      { emoji: '🔁', title: '多清晰度', desc: '主视频 + 备选清晰度直链' }
    ]
  },
  {
    group: '🌐 网页拉取',
    list: [
      { emoji: '📥', title: '#X拉取 <网址>', desc: '拉取网页标题/描述/资源链接' },
      { emoji: '📄', title: '#拉取网页 <网址>', desc: '同上，快捷别名' }
    ]
  },
  {
    group: '🚀 代理（订阅）',
    list: [
      { emoji: '▶️', title: '#X代理开', desc: '启动本地代理（socks5:10890）' },
      { emoji: '⏹️', title: '#X代理关', desc: '停止代理' },
      { emoji: '📊', title: '#X代理状态', desc: '查看运行状态' },
      { emoji: '🧪', title: '#X代理测试', desc: '测试当前节点连通性' },
      { emoji: '📡', title: '#X代理节点 <n>', desc: '切换节点' },
      { emoji: '📋', title: '#X代理列表', desc: '查看节点列表' },
      { emoji: '🔄', title: '#X代理更新', desc: '重新拉取订阅' },
      { emoji: '⚙️', title: '#X代理设置订阅', desc: '修改订阅链接（仅主人）' }
    ]
  },
  {
    group: '🖥 Web 面板',
    list: [
      { emoji: '🖥️', title: '#X面板', desc: '面板地址 + 登录 token' },
      { emoji: '🔑', title: '#X面板重置token', desc: '重置面板 token（仅主人）' },
      { emoji: '🔢', title: '#X面板端口 <n>', desc: '修改面板端口（仅主人）' }
    ]
  },
  {
    group: 'ℹ️ 其他',
    list: [
      { emoji: '❓', title: '#X帮助', desc: '本帮助菜单' }
    ]
  }
]
