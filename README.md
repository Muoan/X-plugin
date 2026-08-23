# 🐦X-plugin 插件说明


****
## 😍插件介绍：
**X/Twitter 推文视频/图片/GIF 解析下载 + 评论抓取 + 用户/时间线/搜索/通知查询（仿 X 渲染页）+ 订阅代理/外部代理 + Web 管理面板：发链接自动解析、下载到服务器生成直链分享、搜索 id 化按人隔离查看**

**本插件拒绝任何【非合理】提议~如遇到问题请卸载本插件或截图＋文字叙述提交issues或加入QQ群或Yunzai论坛反馈即可~**

**⚠️ 免责声明：** 本插件不对 x.com 内容进行审核处理，所以选择外部链接展示相关内容，请你配置好您的公网 IP 及其端口。本插件对 x.com 进行资源获取分享，不做任何处理，使用本插件时如果导致您的账号封禁·禁言等概不负责。如无法接受请卸载本插件。(如果用户虾片那我没办法)

**如您要参与项目请Pull提交欢迎共同参与此项目！**

****

# 😒安装插件：
<details>
  <summary>展开/收起</summary>

**1.github：**

`git clone --depth=1 https://github.com/Muoan/X-plugin.git ./plugins/X-plugin/`

****

**2.gitee：**

`git clone --depth=1 https://gitee.com/muoan/X-plugin.git ./plugins/X-plugin/`

****

**3.gitcode：**

`git clone --depth=1 https://gitcode.com/muoan/X-plugin.git ./plugins/X-plugin/`

或手动将 X-plugin 文件夹放入 `./plugins/` 目录下，重启云崽即可

</details>

****
# 😁安装依赖：
<details>
<summary>展开/收起</summary>

`pnpm i`

`pnpm install --filter=X-plugin`

</details>

****
# 😘功能介绍
<details>
<summary>展开/收起</summary>

| 功能名称 | 功能命令 | 功能讲解 |
| ---- | ---- | ---- |
| 自动解析 | 直接发 X/Twitter 链接 | 自动解析推文视频/图片/GIF，资源以直链发送 |
| 自动下载 | 直接发 X/Twitter 链接 | 自动下载到服务器并分享直链（`#X自动下载 开/关` 控制） |
| 手动解析 | `#X解析+链接` | 解析推文资源（视频/图片/GIF） |
| 下载直链 | `#X下载+链接` | 下载到服务器，生成带 key 直链（默认 60 分钟有效） |
| 代理开关 | `#X代理开` / `#X代理关` | 启动/停止订阅代理（v2ray socks5:10890） |
| 代理状态 | `#X代理状态` | 代理运行状态 + 当前节点 |
| 代理测试 | `#X代理测试` | 当前节点连通测试 |
| 节点切换 | `#X代理节点+序号` | 切换订阅节点并启动 |
| 节点列表 | `#X代理列表` | 查看订阅节点列表 |
| 更新订阅 | `#X代理更新` | 重新拉取订阅 |
| 设置订阅 | `#X代理设置订阅+链接` | 设置订阅链接（仅主人） |
| 面板信息 | `#X面板` | 面板地址 + 登录 token |
| 重置token | `#X面板重置token` | 重置面板 token（仅主人） |
| 面板端口 | `#X面板端口+端口` | 修改面板端口并自动重启（仅主人） |
| 设置 Cookie | `#X设置Cookie+串` | 填 X 账号 Cookie 抓取评论（仅主人） |
| 删除 Cookie | `#X删除Cookie` | 删除 Cookie 停止抓评论（仅主人） |
| 用户资料 | `#X用户+用户名` | 用户详情 + 最近帖子（仿 X 渲染） |
| 首页时间线 | `#X时间线+条数` | 登录后的首页关注流（仅主人） |
| 搜索 | `#X搜索+关键词` | 实时搜索，结果 id 化（条数可在 web 设置） |
| 查看结果 | `#X查看+编号` | 看自己搜索会话的某条，不同人不串 |
| 通知流 | `#X通知` | 最新通知（仅主人） |
| 外部代理 | `#X外部代理+地址` | 走已有代理（socks5/http），不启动 v2ray（仅主人） |
| 帮助菜单 | `#X帮助` | 图片版帮助菜单 |

**💬 评论抓取说明：** 解析时若已配置 Cookie（`#X设置Cookie auth_token=xxx; ct0=yyy` 或整条 Cookie 串），渲染页自动附带评论列表；未配置则仅显示评论数量。抓取评论为非常规访问，**存在封号风险，请务必使用小号 Cookie**。Cookie 明文保存在 `data/config.json`，请勿泄露。

**👤 X 查询说明：** 用户/时间线/搜索/通知通过真实浏览器（Chromium）携带登录态抓取，每次约 10-20 秒；渲染结果 30 分钟有效，并自动纳入面板「分享」tab 管理（可作废/清理）。搜索每条结果独立页面（id 化），`#X查看 <编号>` 按会话查看，会话与查询人绑定、互不串数据；最多条数在 web 设置页「搜索最多条数」控制（1-50）。**⚠️ 页面展示的敏感内容可能未脱敏，请自行评估风险。**

**📁 配置文件：** `plugins/X-plugin/data/config.json`（含代理订阅/节点、面板端口/token、X Cookie 等，`data/` 不随 git 提交）；默认配置参考 `config.example.json`。

</details>

# 😂更新：
**在插件目录执行 `git pull` 即可**

**PS：遇到无法更新或错误提示请检查网络（github 直连被掐时可用 ghfast 代理）**

****
# 😜交流：
**QQ群：[872488071](https://qm.qq.com/q/SA5dEJf6MM)**

**云崽论坛：[Yunzai论坛/文档](https://yzai.top)**

# 😊友情链接：
[Miao-Yunzai](https://gitee.com/yoimiya-kokomi/Miao-Yunzai)😠
[TRSS-Yunzai](https://gitee.com/TimeRainStarSky/Yunzai)


****
# 😍其他：

**素材来源于网络，仅供交流学习使用，严禁用于商业和非法用途**

**Web 面板：浏览器打开 `http://服务器IP:3007`，输入 token 登录，可管理任务/文件/代理（节点切换/全节点测速/订阅设置）**

**资源直链（video.twimg.com / pbs.twimg.com 等）国内直连可能打不开，请开启代理或使用下载直链**

# 🕳️ 挖坑（Roadmap）
