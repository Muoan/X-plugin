export const helpCfg = {
  title: 'X 解析 · 帮助',
  subTitle: 'Miao-Yunzai & Trss-Yunzai & X-plugin',
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
      { emoji: '🔁', title: '多清晰度', desc: '主视频 + 备选清晰度直链' },
      { emoji: '🖥️', title: '面板查询', desc: 'Web 面板 🔎 X 查询 tab 可直接用' }
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
      { emoji: '⚙️', title: '#X代理设置订阅', desc: '修改订阅链接（仅主人）' },
      { emoji: '🔌', title: '#X外部代理 <url>', desc: '用已有代理，不启动 v2ray（仅主人）' },
      { emoji: '🔌', title: '#X外部代理关', desc: '恢复内置 v2ray 订阅模式（仅主人）' }
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
    group: '💬 评论（Cookie）',
    list: [
      { emoji: '🍪', title: '#X设置Cookie', desc: '填 X Cookie 抓评论（仅主人）' },
      { emoji: '🧪', title: '#X检查Cookie', desc: '验证 Cookie 是否有效（仅主人）' },
      { emoji: '🧹', title: '#X删除Cookie', desc: '删除 Cookie 停止抓评论（仅主人）' },
      { emoji: '⚠️', title: '封号风险', desc: '抓评论非官方行为，请用小号 Cookie' }
    ]
  },
  {
    group: '👤 X 查询（Cookie）',
    list: [
      { emoji: '👤', title: '#X用户 <用户名>', desc: '用户资料 + 最近帖子' },
      { emoji: '📰', title: '#X时间线 [条数]', desc: '首页时间线（仅主人）' },
      { emoji: '🔎', title: '#X搜索 <关键词>', desc: '实时搜索，结果 id 化' },
      { emoji: '🔢', title: '#X查看 <编号>', desc: '看自己搜索会话的某条（不串）' },
      { emoji: '🔔', title: '#X通知', desc: '最新通知流（仅主人）' },
      { emoji: '🎛️', title: '条数控制', desc: 'web 设置页「搜索最多条数」1-50' },
      { emoji: '🖥️', title: 'Web 也能用', desc: '面板 🔎 X 查询 tab，无需 QQ 命令' }
    ]
  },
  {
    group: 'ℹ️ 其他',
    list: [
      { emoji: '❓', title: '#X帮助', desc: '本帮助菜单' }
    ]
  }
]
