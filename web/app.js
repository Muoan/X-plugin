const $ = s => document.querySelector(s)
function readToken () {
  return localStorage.getItem('xpanel_token') || (document.cookie.match(/(?:^|;\s*)xpanel_token=([^;]*)/) || [])[1] || ''
}
let TOKEN = readToken()
let TASKS = []
let FILES = []
let pollTimer = null

async function api (path, opts = {}) {
  const headers = { ...(opts.headers || {}) }
  if (TOKEN) headers.Authorization = 'Bearer ' + TOKEN
  if (opts.body && !(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json'
  const res = await fetch(path, { ...opts, headers, body: opts.body ? (opts.body instanceof FormData ? opts.body : JSON.stringify(opts.body)) : undefined })
  let data = null
  try { data = await res.json() } catch { /* ignore */ }
  if (res.status === 401) { showLogin(); throw new Error('未授权') }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`)
  return data
}

let toastTimer = null
function toast (msg, isErr = false) {
  const el = $('#toast')
  el.textContent = msg
  el.classList.remove('hidden', 'err')
  if (isErr) el.classList.add('err')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3000)
}

function fmtSize (n) {
  if (!n) return '-'
  if (n < 1024) return n + ' B'
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB'
  return (n / 1073741824).toFixed(2) + ' GB'
}
function fmtSpeed (n) { return n ? fmtSize(n) + '/s' : '' }
function fmtTime (ts) {
  if (!ts) return '-'
  const d = new Date(ts)
  return `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
function esc (s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function showLogin () {
  $('#mainView').classList.add('hidden')
  $('#loginView').classList.remove('hidden')
  TOKEN = ''
  localStorage.removeItem('xpanel_token')
  document.cookie = 'xpanel_token=; Max-Age=0; path=/'
  stopPoll()
}
async function doLogin () {
  const token = $('#tokenInput').value.trim()
  if (!token) return
  try {
    const data = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) }).then(r => r.json())
    if (!data.ok) throw new Error(data.error || '登录失败')
    TOKEN = data.token
    try { localStorage.setItem('xpanel_token', TOKEN) } catch { /* ignore */ }
    document.cookie = `xpanel_token=${TOKEN}; path=/; max-age=${60 * 60 * 24 * 30}`
    $('#appTitle').textContent = data.title
    enterMain()
  } catch (err) { $('#loginError').textContent = String(err.message || err) }
}
$('#loginBtn').addEventListener('click', doLogin)
$('#tokenInput').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin() })
$('#logoutBtn').addEventListener('click', showLogin)

async function enterMain () {
  $('#loginView').classList.add('hidden')
  $('#mainView').classList.remove('hidden')
  startPoll()
  refreshAll()
}

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'))
    tab.classList.add('active')
    document.querySelectorAll('.panel').forEach(p => p.classList.add('hidden'))
    $('#tab-' + tab.dataset.tab).classList.remove('hidden')
    if (tab.dataset.tab === 'files') loadFiles()
    if (tab.dataset.tab === 'shares') loadShares()
    if (tab.dataset.tab === 'settings') loadConfig()
    if (tab.dataset.tab === 'proxy') loadProxyTab()
  })
})

async function refreshAll () {
  try {
    const [t, v] = await Promise.all([api('/api/tasks'), api('/api/auth/verify')])
    TASKS = t.tasks || []
    renderTasks()
    $('#appTitle').textContent = v.title
    loadProxyStatus()
  } catch (err) { /* 轮询静默 */ }
}

function renderTasks () {
  const list = $('#taskList')
  if (!TASKS.length) { list.innerHTML = '<div class="empty">暂无任务，粘贴链接开始下载</div>'; return }
  const stName = { done: '完成', failed: '失败', downloading: '下载中', queued: '排队中', canceled: '已取消' }
  list.innerHTML = TASKS.map(t => {
    const pct = Math.round(t.progress || 0)
    const cleaned = t.file_deleted === 1
    const name = esc(t.file_name || t.title || t.url.replace(/^https?:\/\//, '').slice(0, 50))
    const files = t.files || []
    const multi = files.length > 1
    const canDl = t.status === 'done' && t.file_id && !cleaned
    const canRetry = ['failed', 'canceled'].includes(t.status)
    const stText = cleaned ? '已清理' : (stName[t.status] || esc(t.status))
    const stCls = cleaned ? 'done' : esc(t.status)
    const fileRows = (multi && t.status === 'done')
      ? files.map(f => {
        const fdel = f.file_deleted === 1
        const nm = esc(f.file_name || '')
        if (fdel) return `<div class="file-row">${nm} <span class="fs">🗑 已清理</span></div>`
        if (f.error) return `<div class="file-row">${nm || esc(f.url)} <span class="fs task-err">${esc(f.error)}</span></div>`
        if (!f.file_id) return `<div class="file-row">${nm || esc(f.url)} <span class="fs">…</span></div>`
        return `<div class="file-row">${nm} <span class="fs">${fmtSize(f.file_size)}</span>` +
          `<button class="btn sm" onclick="downloadFile('${f.file_id}')">⬇</button>` +
          `<button class="btn sm" onclick="previewFile('${f.file_id}')">👁</button></div>`
      }).join('')
      : ''
    return `<div class="task-card" data-id="${t.id}">
      <div class="task-head">
        <span class="task-id">#${esc(t.code || t.id)}</span>
        <span class="task-name">${name}</span>
        <span class="kind ${esc(t.kind)}">${esc(t.kind === '视频' ? '视频' : t.kind === '图片' ? '图片' : t.kind === 'GIF' ? 'GIF' : '直链')}</span>
        <span class="st ${stCls}">${stText}</span>
      </div>
      <div class="url">${esc(t.url)}</div>
      <div class="task-progress"><div style="width:${pct}%;${pct === 100 ? 'background:var(--ok)' : ''}"></div></div>
      <div class="task-meta">
        <span>${pct}%</span>
        <span>${fmtSize(t.downloaded_size)} / ${fmtSize(t.total_size || t.file_size)}</span>
        <span>${fmtSpeed(t.speed)}</span>
        <span>${fmtTime(t.created_at)}</span>
        ${cleaned ? '<span class="cleaned-tag">🗑 已清理</span>' : ''}
      </div>
      ${t.error ? `<div class="task-err">${esc(t.error)}</div>` : ''}
      ${fileRows}
      <div class="task-actions">
        ${t.status === 'done' && (t.files || []).some(f => f.file_id) ? `<button class="btn sm" onclick="copyShare('${esc(t.code || '')}')">🔗 分享</button>` : ''}
        ${canDl && !multi ? `<button class="btn sm" onclick="downloadFile('${t.file_id}')">⬇ 下载文件</button>` : ''}
        ${canDl && !multi ? `<button class="btn sm" onclick="previewFile('${t.file_id}')">👁 预览</button>` : ''}
        ${canRetry ? `<button class="btn sm" onclick="retryTask(${t.id})">🔄 重试</button>` : ''}
        ${t.status === 'queued' || t.status === 'downloading' ? `<button class="btn sm danger" onclick="cancelTask(${t.id})">✕ 取消</button>` : ''}
        <button class="btn sm danger" onclick="deleteTask(${t.id}, '${esc(t.code || '')}')">🗑 删除</button>
      </div>
    </div>`
  }).join('')
}

$('#addTaskBtn').addEventListener('click', addTask)
$('#urlInput').addEventListener('keydown', e => { if (e.key === 'Enter') addTask() })

async function addTask () {
  const url = $('#urlInput').value.trim()
  if (!/^https?:\/\/\S+$/i.test(url)) return toast('请输入 http(s) 链接', true)
  try {
    const data = await api('/api/tasks', { method: 'POST', body: { url } })
    $('#urlInput').value = ''
    toast(`已加入队列 #${data.task.code || data.task.id}`)
    refreshAll()
  } catch (err) { toast(err.message, true) }
}

async function downloadFile (id) { window.open(`/api/files/${id}/download?token=${encodeURIComponent(TOKEN)}`, '_blank') }

function mediaKind (name) {
  const n = String(name || '').toLowerCase()
  if (/\.(mp4|mkv|webm|mov|m4v|avi|ts|flv)$/.test(n)) return 'video'
  if (/\.(jpg|jpeg|png|gif|webp|bmp|avif)$/.test(n)) return 'image'
  if (/\.(mp3|aac|wav|flac|m4a|ogg)$/.test(n)) return 'audio'
  return 'other'
}
function previewFile (id) {
  const list = [...TASKS, ...FILES]
  const f = list.find(x => x.file_id === id || x.id === id)
  if (!f) return toast('找不到该文件', true)
  const name = f.file_name || 'file'
  const kind = mediaKind(name)
  const src = `/api/files/${id}/download?token=${encodeURIComponent(TOKEN)}&inline=1`
  $('#previewTitle').textContent = name
  const body = $('#previewBody')
  if (kind === 'image') {
    body.innerHTML = `<img class="pv-media" src="${src}" alt="${esc(name)}">`
  } else if (kind === 'video') {
    body.innerHTML = `<video class="pv-media" src="${src}" controls autoplay playsinline></video>`
  } else if (kind === 'audio') {
    body.innerHTML = `<audio class="pv-media" src="${src}" controls autoplay></audio>`
  } else {
    body.innerHTML = `<div class="pv-other">该类型暂不支持在线预览（仅图片/视频/音频），请点击下载查看。</div>`
  }
  $('#previewModal').classList.remove('hidden')
}
function closePreview () {
  const body = $('#previewBody')
  body.innerHTML = ''
  $('#previewModal').classList.add('hidden')
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closePreview() })
async function retryTask (id) { try { await api(`/api/tasks/${id}/retry`, { method: 'POST' }); toast('已重新入队'); refreshAll() } catch (err) { toast(err.message, true) } }
async function cancelTask (id) { try { await api(`/api/tasks/${id}/cancel`, { method: 'POST' }); refreshAll() } catch (err) { toast(err.message, true) } }
async function deleteTask (id, code) { if (!confirm(`确认删除任务 #${code || id}（含已下载文件）？`)) return; try { await api(`/api/tasks/${id}`, { method: 'DELETE' }); refreshAll(); loadFiles() } catch (err) { toast(err.message, true) } }

async function copyShare (code) {
  const link = `${location.origin}/s/${code}`
  try {
    await navigator.clipboard.writeText(link)
    toast('✅ 分享链接已复制：' + link)
  } catch {
    prompt('复制分享链接：', link)
  }
}

// ── 分享管理 ──
let SHARES = []

async function loadShares () {
  try {
    const data = await api('/api/shares')
    SHARES = data.list || []
    renderShares()
  } catch (err) { /* 静默 */ }
}

function fmtExpire (ts) {
  if (!ts) return '无期限'
  const left = ts - Date.now()
  if (left <= 0) return '已过期'
  const m = Math.ceil(left / 60000)
  return m >= 60 ? `${Math.floor(m / 60)} 小时后过期` : `${m} 分钟后过期`
}

function renderShares () {
  const list = $('#shareList')
  if (!SHARES.length) {
    list.innerHTML = '<div class="empty">暂无分享链接，下载或解析后自动生成</div>'
    return
  }
  list.innerHTML = SHARES.map(s => `
    <div class="share-card">
      <div class="share-head">
        <span class="share-type">${esc(s.type)}</span>
        <span class="fs share-exp">${fmtExpire(s.expireAt)}</span>
      </div>
      <a class="share-link" href="${esc(s.link)}" target="_blank" rel="noopener">${esc(s.link.replace(/^https?:\/\//, ''))}</a>
      <div class="share-src">📄 原文：${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url)}</a>` : '—'}</div>
      <div class="share-actions">
        <button class="btn sm" onclick="copyShare('${esc(s.code)}')">📋 复制</button>
        <button class="btn danger sm" onclick="revokeShare('${esc(s.code)}')">⭕ 立即作废</button>
      </div>
    </div>`).join('')
}

async function revokeShare (code) {
  if (!confirm('确定作废该分享链接？作废后立即无法访问')) return
  try {
    await api('/api/shares/' + code + '/revoke', { method: 'POST' })
    toast('✅ 已作废：' + code)
    loadShares()
  } catch (err) {
    toast('❌ ' + (err.message || '作废失败'))
  }
}

async function clearAllShares () {
  if (!confirm('确定清理全部分享记录？任务与文件将一并删除')) return
  try {
    const data = await api('/api/shares/clear', { method: 'POST' })
    toast('✅ 已清理 ' + (data.cleared || 0) + ' 条分享记录')
    loadShares()
  } catch (err) {
    toast('❌ ' + (err.message || '清理失败'))
  }
}

async function loadFiles () {
  try {
    const data = await api('/api/files')
    FILES = data.files || []
    const body = $('#fileBody')
    if (!FILES.length) { body.innerHTML = '<tr><td colspan="5" class="empty">暂无已完成文件</td></tr>'; return }
    body.innerHTML = FILES.map(f => `<tr>
      <td>${esc(f.kind || '')}</td>
      <td style="word-break:break-all">${esc(f.file_name)}</td>
      <td>${fmtSize(f.file_size)}</td>
      <td>${f.bot_appid ? (f.target_type === 'group' ? '群聊' : '私聊') : '面板'}</td>
      <td>
        <button class="btn sm" onclick="downloadFile('${f.id}')">⬇ 下载</button>
        <button class="btn sm" onclick="previewFile('${f.id}')">👁 预览</button>
      </td>
    </tr>`).join('')
  } catch (err) { toast(err.message, true) }
}
$('#refreshFilesBtn').addEventListener('click', loadFiles)
$('#refreshSharesBtn').addEventListener('click', loadShares)
$('#clearSharesBtn').addEventListener('click', clearAllShares)

async function loadConfig () {
  try {
    const { config } = await api('/api/config')
    $('#setTitle').value = config.title
    $('#setPort').value = config.port
    $('#setCleanup').value = config.cleanup_minutes
    $('#setMaxFile').value = config.max_file_mb
    $('#tokenBox').textContent = config.token
    if (config.x) {
      $('#setCookie').value = config.x.cookie_configured ? config.x.cookie : ''
      $('#setMaxSearch').value = config.x.max_search_results ?? 10
    }
    loadProxyStatus()
  } catch (err) { toast(err.message, true) }
}

/** 代理 tab 初始化 */
async function loadProxyTab () {
  try {
    const { config } = await api('/api/config')
    if (config.proxy) {
      $('#setSubscribe').value = ''
      $('#setSubscribe').placeholder = config.proxy.subscribe_configured ? '已设置订阅（输入新链接覆盖）' : 'V2Board 订阅地址'
      $('#setProxyPort').value = config.proxy.port
      $('#setExtProxy').value = config.proxy.external_url || ''
    }
    loadProxyStatus()
    loadNodes()
  } catch (err) { toast(err.message, true) }
}

let proxyStatusTimer = null
async function loadProxyStatus () {
  try {
    const s = await api('/api/status')
    const el = $('#proxyStatus')
    el.innerHTML = s.proxyRunning
      ? `代理运行中 · 节点 ${esc(s.nodeName)}`
      : (s.proxyEnabled ? '代理已启用（未运行）' : '代理未启动')
    el.className = 'proxy-status' + (s.proxyRunning ? '' : ' stopped')
    // 全局徽章
    const badge = $('#proxyBadge')
    if (s.proxyRunning) {
      badge.textContent = `● 代理运行中 · ${esc(s.nodeName)}`
      badge.className = 'proxy-badge running'
    } else if (s.proxyEnabled) {
      badge.textContent = '● 代理已启用（未运行）'
      badge.className = 'proxy-badge enabled'
    } else {
      badge.textContent = '● 代理未启动'
      badge.className = 'proxy-badge stopped'
    }
  } catch { /* 静默 */ }
}

$('#proxyBadge').addEventListener('click', () => {
  const tab = document.querySelector('.tab[data-tab="settings"]')
  if (tab) tab.click()
})

async function loadNodes () {
  try {
    const d = await api('/api/proxy/nodes')
    const sel = $('#setNode')
    const list = d.nodes || []
    if (!list.length) {
      sel.innerHTML = '<option value="">（无节点，请先保存订阅）</option>'
      return
    }
    sel.innerHTML = list.map(n => `<option value="${n.idx}" ${n.idx === d.current ? 'selected' : ''}>#${n.idx} ${esc(n.name)}（${esc(n.add)}:${n.port}）</option>`).join('')
  } catch (err) { toast(err.message, true) }
}

function proxyMsg (text, isErr = false) {
  $('#proxyMsg').textContent = text
  $('#proxyMsg').className = isErr ? 'error' : 'success'
  if (text) setTimeout(() => $('#proxyMsg').textContent = '', 4000)
}

$('#saveSubscribeBtn').addEventListener('click', async () => {
  const url = $('#setSubscribe').value.trim()
  if (!url) return proxyMsg('请输入订阅链接', true)
  try {
    const r = await api('/api/proxy/set-subscribe', { method: 'POST', body: { url } })
    proxyMsg(`订阅已保存，拉取到 ${r.count} 个节点`)
    loadNodes()
    loadProxyStatus()
  } catch (err) { proxyMsg(err.message, true) }
})
$('#refreshNodesBtn').addEventListener('click', async () => {
  try {
    const r = await api('/api/proxy/refresh', { method: 'POST' })
    proxyMsg(`已刷新，共 ${r.count} 个节点`)
    loadNodes()
  } catch (err) { proxyMsg(err.message, true) }
})
$('#proxyStartBtn').addEventListener('click', async () => {
  try {
    const idx = $('#setNode').value
    const body = idx !== '' ? { node_index: Number(idx) } : {}
    const r = await api('/api/proxy/start', { method: 'POST', body })
    proxyMsg(r.testOk ? `已启动：${r.name}（连通正常）` : `已启动：${r.name}，但连通测试失败`)
    loadProxyStatus(); loadNodes()
  } catch (err) { proxyMsg(err.message, true) }
})
$('#proxyStopBtn').addEventListener('click', async () => {
  try {
    await api('/api/proxy/stop', { method: 'POST' })
    proxyMsg('代理已停止')
    loadProxyStatus()
  } catch (err) { proxyMsg(err.message, true) }
})
$('#proxyTestBtn').addEventListener('click', async () => {
  try {
    const r = await api('/api/proxy/test', { method: 'POST' })
    proxyMsg(r.ok ? '连通正常 ✅' : '连通失败 ❌')
  } catch (err) { proxyMsg(err.message, true) }
})
$('#proxySwitchBtn').addEventListener('click', async () => {
  const idx = Number($('#setNode').value)
  try {
    const r = await api('/api/proxy/switch', { method: 'POST', body: { node_index: idx } })
    proxyMsg(r.testOk ? `已切换至 ${r.name}（连通正常）` : `已切换至 ${r.name}，但连通测试失败`)
    loadProxyStatus(); loadNodes()
  } catch (err) { proxyMsg(err.message, true) }
})
$('#speedtestBtn').addEventListener('click', async () => {
  const btn = $('#speedtestBtn')
  const msg = $('#speedtestMsg')
  const box = $('#speedtestResult')
  btn.disabled = true
  msg.classList.remove('hidden')
  msg.textContent = '⏳ 正在测速全部节点（串行检测，约 1-2 分钟），请稍候…'
  box.classList.add('hidden')
  try {
    const r = await api('/api/proxy/speedtest', { method: 'POST' })
    msg.classList.add('hidden')
    box.classList.remove('hidden')
    const sorted = [...r.results].sort((a, b) => (a.ok === b.ok) ? (a.ms || 1e9) - (b.ms || 1e9) : (a.ok ? -1 : 1))
    box.innerHTML = `<div class="sp-row" style="background:var(--card2)"><span>测速完成：${r.ok_count}/${r.total} 个节点可用</span></div>` +
      sorted.map(x => `<div class="sp-row">
        <span class="sp-name">#${x.idx} ${esc(x.name)}（${esc(x.add)}:${x.port}）</span>
        ${x.ok ? `<span class="sp-ok">✅ ${x.ms}ms</span>` : `<span class="sp-bad">❌ ${esc(x.error || '超时/失败')}</span>`}
      </div>`).join('')
    loadProxyStatus(); loadNodes()
  } catch (err) {
    msg.classList.add('hidden')
    proxyMsg(err.message, true)
  } finally {
    btn.disabled = false
  }
})
$('#saveExtProxyBtn').addEventListener('click', async () => {
  const url = $('#setExtProxy').value.trim()
  if (url && !/^(socks5h?|http|https):\/\/\S+$/i.test(url)) return proxyMsg('格式不对：socks5://127.0.0.1:7891 或 http://127.0.0.1:7890', true)
  try {
    await api('/api/config', { method: 'PUT', body: { proxy: { external_url: url } } })
    proxyMsg(url ? `已保存外部代理：${url}` : '已清空外部代理（恢复 v2ray 订阅模式）')
    loadProxyStatus()
  } catch (err) { proxyMsg(err.message, true) }
})
/* X 查询 tab */
$('#xqRunBtn').addEventListener('click', async () => {
  const type = $('#xqType').value
  const value = $('#xqValue').value.trim()
  const btn = $('#xqRunBtn')
  const msg = $('#xqMsg')
  const box = $('#xqResult')
  if (type !== 'timeline' && type !== 'notify' && !value) return msg.textContent = '请输入查询参数'; msg.className = 'error'
  btn.disabled = true
  msg.textContent = '⏳ 正在抓取（约 15 秒），请稍候…'
  msg.className = 'success'
  box.classList.add('hidden')
  try {
    const r = await api('/api/x/query', { method: 'POST', body: { type, value } })
    msg.textContent = '✅ 完成，' + (r.title || '')
    const link = $('#xqLink')
    link.href = r.link
    link.textContent = r.link
    box.classList.remove('hidden')
    // 搜索：展示每条独立页面链接
    let extra = ''
    if (r.items && r.items.length) {
      extra = '<div class="form-row"><label>单条结果</label><div class="token-box">' + r.items.map(it =>
        `<a href="${it.link}" target="_blank" rel="noopener">#${it.idx} @${esc(it.user || '?')}</a> ${esc(it.text)}`
      ).join('<br>') + '</div></div>'
    }
    const old = box.querySelector('.xq-extra')
    if (old) old.remove()
    if (extra) {
      const div = document.createElement('div')
      div.className = 'xq-extra'
      div.innerHTML = extra
      box.appendChild(div)
    }
  } catch (err) {
    msg.textContent = '❌ ' + err.message
    msg.className = 'error'
  } finally {
    btn.disabled = false
  }
})
$('#saveConfigBtn').addEventListener('click', async () => {
  try {
    const body = {
      title: $('#setTitle').value,
      port: Number($('#setPort').value),
      cleanup_minutes: Number($('#setCleanup').value),
      max_file_mb: Number($('#setMaxFile').value),
      proxy: { port: Number($('#setProxyPort').value) },
      x: {
        cookie: $('#setCookie').value.trim(),
        max_search_results: Number($('#setMaxSearch').value)
      }
    }
    const { port_changed, proxy_port_changed } = await api('/api/config', { method: 'PUT', body })
    const notes = []
    if (port_changed) notes.push('端口变更需重启云崽生效')
    if (proxy_port_changed) notes.push('代理端口已保存，重启代理后生效')
    $('#configMsg').textContent = notes.length ? '已保存，' + notes.join('；') : '已保存'
    $('#appTitle').textContent = $('#setTitle').value || 'X 下载面板'
    setTimeout(() => $('#configMsg').textContent = '', 4000)
  } catch (err) { toast(err.message, true) }
})
$('#clearCookieBtn').addEventListener('click', async () => {
  if (!confirm('清空 X Cookie？清空后解析不再抓取评论')) return
  try {
    $('#setCookie').value = ''
    await api('/api/config', { method: 'PUT', body: { x: { clear_cookie: true } } })
    $('#configMsg').textContent = '已清空 X Cookie'
    setTimeout(() => $('#configMsg').textContent = '', 4000)
  } catch (err) { toast(err.message, true) }
})
$('#resetTokenBtn').addEventListener('click', async () => {
  if (!confirm('重置后旧 token 立即失效，确认？')) return
  try {
    const { token } = await api('/api/config/reset-token', { method: 'POST' })
    $('#tokenBox').textContent = token
    localStorage.setItem('xpanel_token', token)
    document.cookie = `xpanel_token=${token}; path=/; max-age=${60 * 60 * 24 * 30}`
    TOKEN = token
    toast('token 已重置')
  } catch (err) { toast(err.message, true) }
})

function startPoll () {
  stopPoll()
  pollTimer = setInterval(refreshAll, 2000)
}
function stopPoll () { if (pollTimer) { clearInterval(pollTimer); pollTimer = null } }

(async function init () {
  if (TOKEN) {
    try { await api('/api/auth/verify'); enterMain(); return } catch { /* fallthrough */ }
  }
  showLogin()
})()
