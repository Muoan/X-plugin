import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { getConfig, setConfig, DATA_DIR, PLUGIN_DIR } from './config.js'
import { extractXUrl, getTweet, buildXMessage, formatMedia, pickDownloadUrls, fetchUser, fetchTimeline, fetchSearch, fetchNotifications, renderUserHtml, renderListHtml } from './x.js'
import * as proxy from './proxy.js'
import * as downloader from './downloader.js'
import { fetchText } from './fetch.js'

const WEB_DIR = path.join(PLUGIN_DIR, 'web')
const HISTORY_PATH = path.join(DATA_DIR, 'history.json')
const HISTORY_MAX = 50

const fileKeys = new Map()

/** 下载任务 */
const tasks = new Map()
let taskSeq = 0
let workerBusy = false

function makeTask (url, kind, name) {
  return {
    id: ++taskSeq,
    code: downloader.maId(),
    url,
    kind: kind || 'direct',
    title: name || '',
    status: 'queued',
    progress: 0,
    downloaded_size: 0,
    total_size: 0,
    speed: 0,
    error: '',
    file_id: '',
    file_name: '',
    file_path: '',
    file_size: 0,
    file_deleted: 0,
    files: [],
    created_at: Date.now(),
    finished_at: 0,
    _canceled: false,
    _lastDone: 0,
    _lastTs: 0
  }
}

export function getTasks () {
  return [...tasks.values()]
    .sort((a, b) => b.created_at - a.created_at)
    .map(t => {
      if (t.status === 'done' && t.file_id && t.file_deleted === 0 && !findFileById(t.file_id)) t.file_deleted = 1
      return t
    })
}

export function createTask (url, { kind, name, files } = {}, kick = true) {
  const task = makeTask(url, kind, name)
  if (files) task.files = files
  tasks.set(String(task.id), task)
  if (kick) kickTaskWorker()
  return task
}

/** 更新任务字段 */
export function updateTask (id, patch) {
  const t = tasks.get(String(id))
  if (t) Object.assign(t, patch)
  return t
}

/** 完成记录(QQ侧) */
export function addFinishedTask ({ url, kind = '资源', name = '', files = [] } = {}) {
  const t = makeTask(url, kind, name)
  const total = files.reduce((s, f) => s + (f.file_size || 0), 0)
  t.files = files.map(f => ({
    url: f.url || '',
    kind: f.kind || '资源',
    file_id: f.file_id || '',
    file_name: f.file_name || '',
    file_path: f.file_path || '',
    file_size: f.file_size || 0,
    file_deleted: 0
  }))
  const ok = t.files.filter(f => f.file_id)
  t.file_id = ok[0]?.file_id || ''
  t.file_name = ok[0]?.file_name || ''
  t.file_path = ok[0]?.file_path || ''
  t.file_size = ok[0]?.file_size || 0
  t.downloaded_size = total
  t.total_size = total
  t.progress = 100
  t.status = 'done'
  t.finished_at = Date.now()
  tasks.set(String(t.id), t)
  return t
}

export function shareLink (code) {
  return `${publicUrl()}/s/${code}`
}

/** 渲染页存储（TTL 固定 30 分钟） */
const renders = new Map()

/** 保存渲染页 */
export function renderPage (html, url = '') {
  const id = downloader.maId()
  renders.set(id, { html, url, expireAt: Date.now() + 30 * 60 * 1000 })
  return id
}

/** 渲染页直链 */
export function renderLink (id) {
  return `${publicUrl()}/v/${id}`
}

export function cancelTask (id) {
  const t = tasks.get(String(id))
  if (!t || ['done', 'failed', 'canceled'].includes(t.status)) return false
  t.status = 'canceled'
  t.finished_at = Date.now()
  t._canceled = true
  return true
}

export function retryTask (id) {
  const t = tasks.get(String(id))
  if (!t || !['failed', 'canceled'].includes(t.status)) return false
  t.status = 'queued'
  t.error = ''
  t.progress = 0
  t.downloaded_size = 0
  t.total_size = 0
  t.speed = 0
  t._canceled = false
  t._lastDone = 0
  t._lastTs = 0
  t.finished_at = 0
  kickTaskWorker()
  return true
}

export function deleteTask (id) {
  const t = tasks.get(String(id))
  if (!t) return false
  for (const f of (t.files || [])) {
    if (f.file_path) fs.rmSync(f.file_path, { force: true })
    if (f.file_id) fileKeys.delete(String(f.file_id))
  }
  if (t.file_id) fileKeys.delete(String(t.file_id))
  tasks.delete(String(id))
  return true
}

export function clearTasks () {
  for (const [id, t] of tasks) {
    if (['done', 'failed', 'canceled'].includes(t.status)) {
      deleteTask(id)
    }
  }
}

/** 分享链接列表 */
export function getShares () {
  const list = []
  const ttlMin = getConfig().panel?.cleanupMinutes || 60
  for (const [id, t] of tasks) {
    if (t.status !== 'done') continue
    list.push({
      code: t.code,
      type: '分享',
      link: shareLink(t.code),
      url: t.url || '',
      expireAt: t.finished_at ? t.finished_at + ttlMin * 60 * 1000 : 0,
      fileCount: (t.files || []).length,
      size: t.total_size || 0
    })
  }
  for (const [id, rec] of renders) {
    list.push({
      code: id,
      type: '解析',
      link: renderLink(id),
      url: rec.url || '',
      expireAt: rec.expireAt,
      fileCount: 0,
      size: 0
    })
  }
  return list.sort((a, b) => b.expireAt - a.expireAt)
}

/** 作废分享链接 */
export function revokeShare (code) {
  let hit = false
  for (const [id, t] of tasks) {
    if (t.code === code) {
      deleteTask(id)
      hit = true
    }
  }
  if (renders.has(code)) {
    renders.delete(code)
    hit = true
  }
  return hit
}

/** 清理分享记录 */
export function clearShares () {
  const n = tasks.size + renders.size
  clearTasks()
  renders.clear()
  return n
}

function kickTaskWorker () {
  if (workerBusy) return
  workerBusy = true
  ;(async () => {
    try {
      for (;;) {
        const t = [...tasks.values()].find(x => x.status === 'queued')
        if (!t) break
        await runTask(t)
      }
    } catch { /* ignore */ } finally {
      workerBusy = false
    }
  })()
}

async function runTask (t) {
  t.status = 'downloading'
  t.progress = 0
  try {
    const maxMB = getConfig().panel?.maxFileMB || 500
    const picks = (t.files || []).filter(f => !f.file_id && !f.error)
    if (picks.length) return runMultiTask(t, picks, maxMB)
    const r = await downloader.downloadWithProgress(t.url, {
      id: t.code,
      maxMB,
      onProgress: ({ done, total }) => {
        const now = Date.now()
        if (t._lastTs) t.speed = Math.max(0, Math.round((done - t._lastDone) / ((now - t._lastTs) / 1000)))
        t._lastDone = done
        t._lastTs = now
        t.downloaded_size = done
        t.total_size = total
        t.progress = total ? Math.min(99, Math.round(done / total * 100)) : (done ? 50 : 0)
      }
    })
    if (t._canceled) {
      fs.rmSync(r.path, { force: true })
      t.status = 'canceled'
      t.finished_at = Date.now()
      return
    }
    t.file_id = r.id
    t.file_name = path.basename(r.path)
    t.file_path = r.path
    t.file_size = r.size
    t.files = [{ url: t.url, kind: t.kind, file_id: r.id, file_name: path.basename(r.path), file_path: r.path, file_size: r.size, file_deleted: 0 }]
    t.downloaded_size = r.size
    t.total_size = r.size
    t.progress = 100
    t.speed = 0
    createFileKey(r.id)
    t.status = 'done'
    t.finished_at = Date.now()
  } catch (err) {
    t.status = 'failed'
    t.error = err?.message || String(err)
    t.finished_at = Date.now()
  }
}

/** 多资源任务 */
async function runMultiTask (t, picks, maxMB) {
  const files = []
  let total = 0
  for (const p of picks) {
    try {
      const r = await downloader.downloadWithProgress(p.url, {
        id: downloader.maId(),
        maxMB,
        onProgress: ({ done, total: tot }) => {
          const now = Date.now()
          const base = files.reduce((s, f) => s + (f.file_size || 0), 0)
          if (t._lastTs) t.speed = Math.max(0, Math.round((done + base - t._lastDone) / ((now - t._lastTs) / 1000)))
          t._lastDone = done + base
          t._lastTs = now
          t.downloaded_size = done + base
          t.total_size = total + tot
          t.progress = t.total_size ? Math.min(99, Math.round(t.downloaded_size / t.total_size * 100)) : (done ? 50 : 0)
        }
      })
      if (t._canceled) {
        fs.rmSync(r.path, { force: true })
        for (const f of files) fs.rmSync(f.file_path, { force: true })
        t.status = 'canceled'
        t.finished_at = Date.now()
        return
      }
      createFileKey(r.id)
      files.push({ url: p.url, kind: p.kind, file_id: r.id, file_name: path.basename(r.path), file_path: r.path, file_size: r.size, file_deleted: 0 })
      total += r.size
      t.files = files
    } catch (err) {
      files.push({ url: p.url, kind: p.kind, error: err?.message || String(err), file_id: '', file_path: '' })
      t.files = files
    }
  }
  const ok = files.filter(f => f.file_id)
  if (!ok.length) {
    t.status = 'failed'
    t.error = '全部资源下载失败'
    t.finished_at = Date.now()
    return
  }
  t.file_id = ok[0].file_id
  t.file_name = ok[0].file_name
  t.file_path = ok[0].file_path
  t.file_size = ok[0].file_size
  t.downloaded_size = total
  t.total_size = total
  t.progress = 100
  t.speed = 0
  t.status = 'done'
  t.finished_at = Date.now()
}

function createFileKey (id) {
  const cfg = getConfig()
  const ttlMs = (cfg.panel?.cleanupMinutes || 60) * 60 * 1000
  const key = crypto.randomBytes(8).toString('hex')
  fileKeys.set(String(id), { key, expireAt: Date.now() + ttlMs })
  return { key, ttlMin: cfg.panel?.cleanupMinutes || 60 }
}
export { createFileKey }

/** 复用 key */
function getFileKey (id) {
  const rec = fileKeys.get(String(id))
  const ttlMin = getConfig().panel?.cleanupMinutes || 60
  if (rec && Date.now() < rec.expireAt) {
    return { key: rec.key, ttlMin }
  }
  return createFileKey(id)
}

function checkFileKey (id, key) {
  const rec = fileKeys.get(String(id))
  if (!rec || !key || rec.key !== String(key) || Date.now() > rec.expireAt) {
    if (rec && Date.now() > rec.expireAt) fileKeys.delete(String(id))
    return false
  }
  return true
}

const BLOCK_UA = /MicroMessenger|MQQBrowser|QBBrowser|QQBrowser|V1_AND_SQ|TencentTraveler|wxwork|QQDownload|QQ\/|qzone|Android.*\bQQ\b/i

const BLOCK_PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>请使用浏览器打开</title><style>*{margin:0;padding:0;box-sizing:border-box}body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(160deg,#eef4ff,#f7faff);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;padding:20px}.card{background:#fff;border-radius:16px;box-shadow:0 8px 30px rgba(37,99,235,.12);padding:36px 28px;max-width:420px;width:100%;text-align:center;border-top:4px solid #2563eb}h1{font-size:20px;color:#1e3a8a;margin-bottom:14px}p{font-size:14px;color:#475569;line-height:1.8}</style></head><body><div class="card"><h1>🔒 请在浏览器中打开</h1><p>微信 / QQ 内无法访问本链接。<br>请点击右上角「在浏览器打开」，<br>或复制链接到手机 / 电脑浏览器访问。</p></div></body></html>`

const VERIFY_PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>X 资源 · 文件验证</title><style>*{margin:0;padding:0;box-sizing:border-box}body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(160deg,#0f172a,#1e293b);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;padding:20px}.card{background:#fff;border-radius:16px;box-shadow:0 8px 30px rgba(37,99,235,.12);padding:32px 28px;max-width:420px;width:100%;text-align:center;border-top:4px solid #2563eb}h1{font-size:20px;color:#1e3a8a;margin-bottom:18px}#status{color:#2563eb;font-size:15px;padding:24px 0}#fileInfo{display:none}.fname{font-size:16px;color:#1e293b;font-weight:600;word-break:break-all;margin-bottom:8px}.fmeta{font-size:13px;color:#64748b;margin-bottom:22px}.btns{display:flex;gap:12px;justify-content:center;flex-wrap:wrap}.btn{display:inline-block;padding:11px 22px;border-radius:10px;font-size:15px;text-decoration:none;font-weight:600}.btn.primary{background:#2563eb;color:#fff}.btn.primary:hover{background:#1d4ed8}.btn.ghost{border:1px solid #93c5fd;color:#2563eb;background:#eff6ff}.btn.ghost:hover{background:#dbeafe}.disc{margin-top:22px;font-size:11px;color:#94a3b8;line-height:1.6}.spin{display:inline-block;width:18px;height:18px;border:2px solid #bfdbfe;border-top-color:#2563eb;border-radius:50%;animation:sp 1s linear infinite;vertical-align:-3px;margin-right:8px}@keyframes sp{to{transform:rotate(360deg)}}.err{color:#dc2626;font-size:14px;padding:16px 0}</style></head><body><div class="card"><h1>📥 X 资源 · 文件验证</h1><div id="status"><span class="spin"></span>正在验证，请稍候…</div><div id="fileInfo"><p class="fname" id="fname"></p><p class="fmeta" id="fmeta"></p><div class="btns"><a id="dlBtn" class="btn primary" target="_blank" rel="noopener">下载文件</a><a id="pvBtn" class="btn ghost" style="display:none" target="_blank" rel="noopener">在线预览</a></div></div><p class="disc">直链有效期 ${'${ttlMin}'} 分钟，过期自动删除</p></div><script>(function(){var id=location.pathname.split('/').pop();var s=document.getElementById('status');fetch('/api/files/'+id+'/verify').then(function(r){if(!r.ok)return r.json().then(function(d){throw new Error(d.error||'验证失败')});return r.json()}).then(function(d){s.style.display='none';document.getElementById('fileInfo').style.display='block';document.getElementById('fname').textContent=d.fileName;document.getElementById('fmeta').textContent=(d.fileSize/1048576).toFixed(1)+' MB'+(d.canPreview?' · 支持在线预览':'');var key=encodeURIComponent(d.key);document.getElementById('dlBtn').href='/api/files/'+id+'/download?key='+key;if(d.canPreview){var pv=document.getElementById('pvBtn');pv.href='/api/files/'+id+'/download?key='+key+'&inline=1';pv.style.display='inline-block'}}).catch(function(e){s.innerHTML='<span class="err">验证失败：'+(e.message||'请重试')+'</span>'})})()</script></body></html>`

/** 验证页 */
export function verifyPage (id) {
  return VERIFY_PAGE.replace('${ttlMin}', String(getConfig().panel?.cleanupMinutes || 60))
}

export function publicUrl () {
  const cfg = getConfig()
  return (cfg.panel?.publicUrl || `http://111.170.175.22:${cfg.panel?.port || 3007}`).replace(/\/$/, '')
}

export function fileLink (id) {
  return `${publicUrl()}/f/${id}`
}

export function downloadLink (id, key) {
  const u = new URL(`${publicUrl()}/api/files/${id}/download`)
  u.searchParams.set('key', key)
  return u.toString()
}

let server = null
let cleanupTimer = null

/** 令牌历史 */

export function getToken () {
  const cfg = getConfig()
  if (!cfg.panel?.token) {
    const token = crypto.randomBytes(6).toString('hex')
    setConfig({ panel: { token } })
    return token
  }
  return cfg.panel.token
}

export function resetToken () {
  const token = crypto.randomBytes(6).toString('hex')
  setConfig({ panel: { token } })
  return token
}

function maskSecret (s) {
  s = String(s || '')
  if (!s) return ''
  if (s.length <= 12) return '*'.repeat(s.length)
  return s.slice(0, 6) + '*'.repeat(8) + s.slice(-4)
}

function checkAuth (req, token) {
  if (!token) return false
  const h = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (h && h === token) return true
  const url = new URL(req.url, 'http://localhost')
  return url.searchParams.get('token') === token
}

function loadHistory () {
  try { return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8')) } catch { return [] }
}

function saveHistory (list) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(list.slice(0, HISTORY_MAX), null, 2), { mode: 0o600 })
}

function pushHistory (entry) {
  const list = loadHistory()
  list.unshift(entry)
  saveHistory(list)
}

/** http 工具 */

function json (res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  })
  res.end(body)
}

function sendFile (res, file, type) {
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { error: '文件不存在' })
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' })
    res.end(data)
  })
}

function sendHtml (res, html) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(html)
}

/** 分享落地页 */
function sharePage (t) {
  const esc = (s) => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const ttlMin = Math.max(1, Math.round(((getConfig().panel?.fileTtlMin || 60) || 60)))
  const rows = (t.files || []).map((f, i) => {
    if (f.file_deleted === 1) return `<div class="row"><span class="idx">${i + 1}️⃣</span><div class="info"><p class="nm">${esc(f.file_name || '资源')}</p><p class="meta">🗑 已过期清理</p></div></div>`
    if (!f.file_id) return `<div class="row"><span class="idx">${i + 1}️⃣</span><div class="info"><p class="nm">${esc(f.file_name || f.kind || '资源')}</p><p class="meta err">下载失败：${esc(f.error || '未知错误')}</p></div></div>`
    const rec = createFileKey(f.file_id)
    const dl = downloadLink(f.file_id, rec.key)
    const pv = downloader.canPreview(path.extname(f.file_name || '')) ? `<a class="btn ghost" href="${dl}&inline=1">👁 预览</a>` : ''
    return `<div class="row"><span class="idx">${i + 1}️⃣</span><div class="info"><p class="nm">${esc(f.file_name || '资源')}</p><p class="meta">${esc(f.kind || '')} · ${fmtSize(f.file_size)}</p></div>${pv}<a class="btn" href="${dl}">⬇ 下载</a></div>`
  }).join('')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>X 资源分享</title><style>*{margin:0;padding:0;box-sizing:border-box}body{min-height:100vh;background:linear-gradient(160deg,#0f172a,#1e293b);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;padding:20px;display:flex;justify-content:center}.card{background:#fff;border-radius:16px;box-shadow:0 8px 30px rgba(37,99,235,.12);padding:24px;max-width:520px;width:100%;border-top:4px solid #2563eb;margin:auto}.hd{display:flex;align-items:center;gap:10px;margin-bottom:4px}.hd h1{font-size:19px;color:#1e3a8a;font-weight:700}.sub{font-size:13px;color:#64748b;margin-bottom:18px}.row{display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid #f1f5f9}.row:last-child{border-bottom:none}.idx{font-size:16px;width:26px;text-align:center;flex-shrink:0}.info{flex:1;min-width:0}.nm{font-size:15px;color:#1e293b;font-weight:600;word-break:break-all}.meta{font-size:12px;color:#94a3b8;margin-top:2px}.meta.err{color:#dc2626}.btn{display:inline-block;padding:9px 16px;border-radius:9px;font-size:13px;text-decoration:none;font-weight:600;background:#eff6ff;color:#2563eb;border:1px solid #bfdbfe;white-space:nowrap}.btn.ghost{background:#fff;color:#2563eb}.disc{margin-top:16px;font-size:11px;color:#94a3b8;line-height:1.7;text-align:center}</style></head><body><div class="card"><div class="hd"><h1>📥 X 资源分享</h1></div><p class="sub">${esc(t.kind || '资源')}${t.title ? ' · ' + esc(t.title) : ''}</p>${rows}<p class="disc">共 ${(t.files || []).length} 个资源，链接 ${ttlMin} 分钟内有效<br>手机端请使用浏览器打开下载</p></div></body></html>`
}

/** 分享失效页 */
function shareNotFound () {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>链接失效</title><style>*{margin:0;padding:0;box-sizing:border-box}body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(160deg,#0f172a,#1e293b);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;padding:20px}.card{background:#fff;border-radius:16px;box-shadow:0 8px 30px rgba(37,99,235,.12);padding:32px;max-width:380px;width:100%;text-align:center;border-top:4px solid #dc2626}h1{font-size:18px;color:#991b1b;margin-bottom:10px}p{font-size:13px;color:#64748b}</style></head><body><div class="card"><h1>🔗 链接无效或已过期</h1><p>资源可能已被清理，请重新获取</p></div></body></html>`
}

function fmtSize (n) {
  n = Number(n) || 0
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB'
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB'
  return n + ' B'
}

function sendText (res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end(text)
}

const MIME = {
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg'
}

/** 按 id 查文件 */
function findFileById (id) {
  try {
    for (const name of fs.readdirSync(downloader.DOWNLOAD_DIR)) {
      if (name.startsWith(`${id}.`)) {
        const p = path.join(downloader.DOWNLOAD_DIR, name)
        if (fs.statSync(p).isFile()) return p
      }
    }
  } catch { /* ignore */ }
  return null
}

function readBody (req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', c => {
      size += c.length
      if (size > 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) } catch { reject(new Error('JSON 解析失败')) }
    })
    req.on('error', reject)
  })
}

/** 服务 */

export function start () {
  if (server) return server
  const cfg = getConfig()
  const token = getToken()
  const port = cfg.panel?.port || 3007

  // 清空遗留文件
  downloader.cleanupOnStart()
  proxy.killStale()
  fileKeys.clear()

  // 定时清理
  const sweep = () => {
    const ttl = getConfig().panel?.cleanupMinutes || 60
    downloader.cleanupExpired(ttl)
    const now = Date.now()
    for (const [id, rec] of fileKeys) {
      if (now > rec.expireAt) fileKeys.delete(String(id))
    }
    for (const [id, rec] of renders) {
      if (now > rec.expireAt) renders.delete(id)
    }
  }
  sweep()
  if (cleanupTimer) clearInterval(cleanupTimer)
  cleanupTimer = setInterval(sweep, 5 * 60 * 1000)
  cleanupTimer.unref?.()

  server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') return json(res, 200, {})
      const url = new URL(req.url, 'http://localhost')
      const p = url.pathname

      // 前端页面
      if (p === '/' || p === '/index.html') {
        return sendFile(res, path.join(WEB_DIR, 'index.html'), 'text/html; charset=utf-8')
      }
      // 前端静态资源
      if (p === '/style.css') return sendFile(res, path.join(WEB_DIR, 'style.css'), 'text/css; charset=utf-8')
      if (p === '/app.js') return sendFile(res, path.join(WEB_DIR, 'app.js'), 'application/javascript; charset=utf-8')

      // 渲染页直链（解析/拉取结果，TTL 1h）
      const vMatch = p.match(/^\/v\/(ma-[0-9a-f]+)$/)
      if (vMatch) {
        const rec = renders.get(vMatch[1])
        if (!rec || Date.now() > rec.expireAt) {
          if (rec) renders.delete(vMatch[1])
          return sendHtml(res, shareNotFound())
        }
        return sendHtml(res, rec.html)
      }

      // 媒体代理（仅 twimg，流式）
      if (p === '/img') {
        const u = url.searchParams.get('u') || ''
        if (!/^https:\/\/(pbs|video|abs)\.twimg\.com\//i.test(u)) return sendText(res, 400, 'bad url')
        // 媒体按需代理：访问才开，空闲自动关
        try {
          if (!proxy.getStatus().running) await proxy.startProxy({ skipTest: true, owner: 'media' })
          proxy.touchMedia()
        } catch { /* 代理失败直连 */ }
        let mime = 'application/octet-stream'
        try { mime = MIME[path.extname(new URL(u).pathname).toLowerCase()] || mime } catch { /* ignore */ }
        const args = proxy.getStatus().running
          ? ['-sL', '--max-time', '300', '--socks5-hostname', '127.0.0.1:10890', '--connect-timeout', '5', '-o', '-', u]
          : ['-sL', '--max-time', '300', '--connect-timeout', '5', '-o', '-', u]
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store', 'Content-Disposition': 'inline' })
        const cp = spawn('curl', args, { stdio: ['ignore', 'pipe', 'ignore'] })
        cp.stdout.pipe(res)
        cp.on('error', () => res.end())
        return undefined
      }

      // 分享落地页
      const sMatch = p.match(/^\/s\/(ma-[0-9a-f]+)$/)
      if (sMatch) {
        const t = [...tasks.values()].find(x => x.code === sMatch[1])
        if (!t) return sendHtml(res, shareNotFound())
        return sendHtml(res, sharePage(t))
      }

      // 文件验证页
      const fMatch = p.match(/^\/f\/(ma-[0-9a-f]+|[0-9a-f]+)$/)
      if (fMatch) {
        const id = fMatch[1]
        const actual = findFileById(id)
        if (!actual) return sendText(res, 404, '文件不存在或已过期')
        if (BLOCK_UA.test(String(req.headers['user-agent'] || ''))) {
          return sendHtml(res, BLOCK_PAGE)
        }
        return sendHtml(res, verifyPage(id))
      }

      // 文件下载
      const dlMatch = p.match(/^\/api\/files\/(ma-[0-9a-f]+|[0-9a-f]+)\/(verify|download)$/)
      if (dlMatch) {
        const id = dlMatch[1]
        const action = dlMatch[2]
        const file = findFileById(id)
        if (!file) return json(res, 404, { error: '文件不存在或已过期' })
        if (action === 'verify') {
          const { key } = getFileKey(id)
          return json(res, 200, { fileName: path.basename(file), fileSize: fs.statSync(file).size, canPreview: downloader.canPreview(path.extname(file)), key })
        }
        // 令牌直链
        const tokenOk = checkAuth(req, token)
        const keyOk = checkFileKey(id, url.searchParams.get('key'))
        if (!tokenOk && !keyOk) return json(res, 401, { error: '请先通过浏览器验证' })
        if (!tokenOk && BLOCK_UA.test(String(req.headers['user-agent'] || ''))) {
          return sendHtml(res, BLOCK_PAGE)
        }
        const inline = url.searchParams.get('inline') === '1'
        const ext = path.extname(file)
        const type = MIME[ext] || 'application/octet-stream'
        const stat = fs.statSync(file)
        const disp = `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`
        const range = req.headers.range
        if (range) {
          const m = /bytes=(\d*)-(\d*)/.exec(String(range))
          let start = m && m[1] ? parseInt(m[1], 10) : 0
          let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1
          if (Number.isNaN(start)) start = 0
          if (Number.isNaN(end) || end >= stat.size) end = stat.size - 1
          if (start > end) return json(res, 416, { error: 'Range 无效' })
          res.writeHead(206, {
            'Content-Type': type,
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': end - start + 1,
            'Content-Disposition': disp,
            'Cache-Control': 'no-store'
          })
          fs.createReadStream(file, { start, end }).pipe(res)
          return
        }
        res.writeHead(200, {
          'Content-Type': type,
          'Content-Length': stat.size,
          'Accept-Ranges': 'bytes',
          'Content-Disposition': disp,
          'Cache-Control': 'no-store'
        })
        fs.createReadStream(file).pipe(res)
        return
      }

      if (!p.startsWith('/api/')) return json(res, 404, { error: 'Not Found' })

      // 登录免认证
      if (p === '/api/login' || p === '/api/auth/login') {
        if (req.method !== 'POST') return json(res, 405, { error: 'Method Not Allowed' })
        const body = await readBody(req)
        if (String(body.token || '') === token) {
          return json(res, 200, { ok: true, token, title: getConfig().panel?.title || 'X 下载面板' })
        }
        return json(res, 401, { error: 'token 错误' })
      }

      if (p === '/api/auth/verify' && req.method === 'GET') {
        return json(res, 200, { title: getConfig().panel?.title || 'X 下载面板' })
      }

      // 其余需认证
      if (!checkAuth(req, token)) return json(res, 401, { error: '未授权，请先登录' })

      // X 查询（浏览器通道：用户/时间线/搜索/通知）
      if (req.method === 'POST' && p === '/api/x/query') {
        const body = await readBody(req)
        const type = String(body.type || '')
        const value = String(body.value || '').trim()
        try {
          // 有外部直接用
          if (!proxy.getStatus().external) {
            if (!proxy.getStatus().running) await proxy.startProxy({ skipTest: true, owner: '' })
          }
          let html = ''
          let link = ''
          let title = ''
          if (type === 'user') {
            if (!/^[A-Za-z0-9_]{1,20}$/.test(value)) return json(res, 400, { error: '用户名格式不对' })
            const { user, tweets } = await fetchUser(value)
            html = renderUserHtml(user, tweets)
            link = `https://x.com/${value}`
            title = `${tweets?.length || 0} 条帖子`
          } else if (type === 'timeline') {
            const list = await fetchTimeline()
            html = renderListHtml({ title: '首页时间线', subtitle: `最新 ${list.length} 条`, items: list.slice(0, 20) })
            link = 'https://x.com/home'
            title = `${Math.min(list.length, 20)} 条推文`
          } else if (type === 'search') {
            if (!value) return json(res, 400, { error: '请输入关键词' })
            const list = await fetchSearch(value)
            const maxN = Math.min(Number(getConfig().x?.maxSearchResults || 10), 50)
            const items = list.slice(0, maxN)
            // 每条独立页面（id 化）
            const pageItems = items.map((t, i) => {
              const pid = renderPage(renderListHtml({ title: `${value} · 结果 ${i + 1}`, items: [t] }), t.url || `https://x.com/search?q=${encodeURIComponent(value)}`)
              return { idx: i + 1, link: renderLink(pid), user: t.screen_name, text: (t.text || '').slice(0, 60) }
            })
            html = renderListHtml({ title: `搜索：${value}`, subtitle: `最新 ${items.length} 条`, items })
            link = `https://x.com/search?q=${encodeURIComponent(value)}`
            title = `${items.length} 条结果`
            return json(res, 200, { link: renderLink(renderPage(html, link)), title, items: pageItems })
          } else if (type === 'notify') {
            const list = await fetchNotifications()
            html = renderListHtml({ title: '通知', subtitle: `最新 ${list.length} 条`, items: list.slice(0, 30), type: 'notifications' })
            link = 'https://x.com/notifications'
            title = `${list.length} 条通知`
          } else {
            return json(res, 400, { error: '未知查询类型' })
          }
          const id = renderPage(html, link)
          return json(res, 200, { link: renderLink(id), title })
        } catch (err) {
          return json(res, 500, { error: err.message })
        }
      }

      if (req.method === 'POST' && p === '/api/parse') {
        const body = await readBody(req)
        const info = extractXUrl(body.url || '')
        if (!info) return json(res, 400, { error: '未识别到 X/Twitter 链接' })
        const { source, tweet } = await getTweet(info)
        const media = formatMedia(tweet)
        const message = buildXMessage(tweet, source)
        const entry = {
          time: Date.now(),
          url: info.url,
          user: tweet.author?.screen_name || '',
          name: tweet.author?.name || '',
          text: tweet.text || '',
          media,
          message,
          source
        }
        pushHistory(entry)
        return json(res, 200, { entry })
      }

      if (req.method === 'GET' && p === '/api/history') {
        return json(res, 200, { list: loadHistory() })
      }

      if (req.method === 'POST' && p === '/api/history/clear') {
        saveHistory([])
        return json(res, 200, { ok: true })
      }

      // 任务接口
      if (p === '/api/tasks') {
        if (req.method === 'GET') return json(res, 200, { tasks: getTasks() })
        if (req.method === 'POST') {
          const body = await readBody(req)
          const url = String(body.url || '').trim()
          if (!url) return json(res, 400, { error: '缺少 url' })
          let dlUrl = url
          let kind = 'direct'
          let name = ''
          const info = extractXUrl(url)
          if (info) {
            try {
              const { tweet } = await getTweet(info)
              const picks = pickDownloadUrls(tweet)
              if (!picks.length) {
                console.error('[X面板] 无资源 media =', JSON.stringify((tweet?.media?.all || []).map(m => m.type)), 'source =', source)
                return json(res, 400, { error: '该推文没有可下载的视频/图片资源' })
              }
              const task = createTask(url, {
                kind: picks[0].kind,
                name: tweet.author?.screen_name ? `@${tweet.author.screen_name}` : '',
                files: picks.map(p => ({ url: p.url, kind: p.kind }))
              })
              return json(res, 200, { task })
            } catch (err) {
              return json(res, 400, { error: '推文解析失败：' + (err?.message || err) })
            }
          }
          const task = createTask(dlUrl, { kind, name })
          return json(res, 200, { task })
        }
        return json(res, 405, { error: 'Method Not Allowed' })
      }

      if (req.method === 'POST' && p === '/api/tasks/clear') {
        clearTasks()
        return json(res, 200, { ok: true })
      }

      // 分享管理
      if (req.method === 'GET' && p === '/api/shares') {
        return json(res, 200, { list: getShares() })
      }
      if (req.method === 'POST' && p === '/api/shares/clear') {
        const n = clearShares()
        return json(res, 200, { ok: true, cleared: n })
      }
      const shareOpMatch = p.match(/^\/api\/shares\/(ma-[0-9a-f]+)\/revoke$/)
      if (req.method === 'POST' && shareOpMatch) {
        const ok = revokeShare(shareOpMatch[1])
        return json(res, ok ? 200 : 400, ok ? { ok: true } : { error: '分享不存在或已过期' })
      }

      // 任务操作
      const taskOpMatch = p.match(/^\/api\/tasks\/(\d+)\/(cancel|retry)$/)
      if (req.method === 'POST' && taskOpMatch) {
        const [, tid, op] = taskOpMatch
        const ok = op === 'cancel' ? cancelTask(tid) : retryTask(tid)
        return json(res, ok ? 200 : 400, ok ? { ok: true } : { error: '操作失败：任务不存在或状态不允许' })
      }
      const taskDelMatch = p.match(/^\/api\/tasks\/(\d+)$/)
      if (req.method === 'DELETE' && taskDelMatch) {
        const ok = deleteTask(taskDelMatch[1])
        return json(res, ok ? 200 : 400, ok ? { ok: true } : { error: '任务不存在' })
      }

      // 文件列表
      if (req.method === 'GET' && p === '/api/files') {
        const files = getTasks()
          .filter(t => t.status === 'done' && t.file_id && t.file_deleted === 0)
          .map(t => ({
            id: t.file_id,
            file_name: t.file_name,
            file_size: t.file_size,
            kind: t.kind,
            created_at: t.finished_at || t.created_at,
            url: t.url
          }))
        return json(res, 200, { files })
      }

      // 面板配置
      if (req.method === 'GET' && p === '/api/config') {
        const cfg = getConfig()
        return json(res, 200, { config: {
          title: cfg.panel?.title || 'X 下载面板',
          port: cfg.panel?.port || 3007,
          cleanup_minutes: cfg.panel?.cleanupMinutes || 60,
          max_file_mb: cfg.panel?.maxFileMB || 500,
          token,
          proxy: {
            subscribe_url: maskSecret(cfg.proxy?.subscribeUrl || ''),
            subscribe_configured: !!cfg.proxy?.subscribeUrl,
            port: cfg.proxy?.port || 10890,
            node_index: cfg.proxy?.nodeIndex ?? 0,
            external_url: cfg.proxy?.externalUrl || ''
          },
          x: {
            cookie: cfg.x?.cookie || '',
            cookie_configured: !!cfg.x?.cookie,
            auto_download: cfg.x?.autoDownload !== false,
            max_search_results: cfg.x?.maxSearchResults ?? 10
          }
        } })
      }
      if (req.method === 'PUT' && p === '/api/config') {
          const body = await readBody(req)
          const patch = {}
          if (body.title !== undefined) patch.title = String(body.title)
          if (body.port !== undefined) patch.port = Number(body.port)
          if (body.cleanup_minutes !== undefined) patch.cleanupMinutes = Number(body.cleanup_minutes)
          if (body.max_file_mb !== undefined) patch.maxFileMB = Number(body.max_file_mb)
          setConfig({ panel: patch })
          const oldProxyPort = getConfig().proxy?.port || 10890
          if (body.proxy) {
            const ppatch = {}
            if (body.proxy.subscribe_url !== undefined) ppatch.subscribeUrl = String(body.proxy.subscribe_url)
            if (body.proxy.port !== undefined) ppatch.port = Number(body.proxy.port)
            if (body.proxy.node_index !== undefined) ppatch.nodeIndex = Number(body.proxy.node_index)
            if (body.proxy.external_url !== undefined) ppatch.externalUrl = String(body.proxy.external_url)
            if (Object.keys(ppatch).length) setConfig({ proxy: ppatch })
          }
          const proxyPortChanged = !!(body.proxy?.port !== undefined && Number(body.proxy.port) !== oldProxyPort)
          const portChanged = !!(body.port !== undefined && Number(body.port) !== port)
          // X Cookie 保存/清空
          if (body.x?.cookie !== undefined) setConfig({ x: { cookie: String(body.x.cookie) } })
          if (body.x?.clear_cookie) setConfig({ x: { cookie: '' } })
          if (body.x?.max_search_results !== undefined) setConfig({ x: { maxSearchResults: Math.min(Math.max(Number(body.x.max_search_results) || 10, 1), 50) } })
          return json(res, 200, { ok: true, port_changed: portChanged, proxy_port_changed: proxyPortChanged })
      }

      if (req.method === 'POST' && p === '/api/config/reset-token') {
        const nt = resetToken()
        return json(res, 200, { token: nt })
      }

      if (req.method === 'GET' && p === '/api/status') {
        const s = proxy.getStatus()
        return json(res, 200, {
          port,
          proxyRunning: s.running,
          proxyEnabled: s.enabled,
          nodeCount: s.nodeCount,
          nodeName: s.node ? `${s.node.name}（${s.node.add}:${s.node.port}）` : '',
          subscribeConfigured: !!getConfig().proxy.subscribeUrl,
          token
        })
      }

      if (req.method === 'POST' && p === '/api/proxy/start') {
        try {
          const body = await readBody(req)
          const idx = body.node_index !== undefined ? Number(body.node_index) : undefined
          const r = await proxy.startProxy({ nodeIndex: idx })
          return json(res, 200, { ok: true, name: r.node.name, testOk: r.ok, error: r.error })
        } catch (err) {
          return json(res, 500, { error: err.message })
        }
      }

      if (req.method === 'POST' && p === '/api/proxy/stop') {
        proxy.stopProxy()
        return json(res, 200, { ok: true })
      }

      if (req.method === 'POST' && p === '/api/proxy/test') {
        if (!proxy.getStatus().running) return json(res, 400, { error: '代理未运行' })
        const ok = await proxy.testProxy()
        return json(res, 200, { ok })
      }

      if (req.method === 'POST' && p === '/api/proxy/refresh') {
        try {
          const nodes = await proxy.refreshNodes()
          return json(res, 200, { ok: true, count: nodes.length })
        } catch (err) {
          return json(res, 500, { error: err.message })
        }
      }

      if (req.method === 'POST' && p === '/api/proxy/set-subscribe') {
        try {
          const body = await readBody(req)
          const url = String(body.url || '').trim()
          if (!/^https?:\/\/\S+$/i.test(url)) return json(res, 400, { error: '请输入 http(s) 订阅链接' })
          const old = getConfig().proxy?.subscribeUrl || ''
          setConfig({ proxy: { subscribeUrl: url } })
          try {
            const nodes = await proxy.refreshNodes()
            return json(res, 200, { ok: true, count: nodes.length })
          } catch (err) {
            setConfig({ proxy: { subscribeUrl: old } })
            return json(res, 500, { error: err.message })
          }
        } catch (err) {
          return json(res, 500, { error: err.message })
        }
      }

      if (req.method === 'GET' && p === '/api/proxy/nodes') {
        const s = proxy.getStatus()
        const cfg = getConfig()
        const nodes = proxy.getNodes()
        const cur = Math.min(cfg.proxy?.nodeIndex ?? 0, Math.max(0, nodes.length - 1))
        return json(res, 200, {
          running: s.running,
          current: cur,
          nodes: nodes.map((n, i) => ({ idx: i, name: n.name, add: n.add, port: n.port }))
        })
      }

      if (req.method === 'POST' && p === '/api/proxy/switch') {
        try {
          const body = await readBody(req)
          const idx = Number(body.node_index)
          const r = await proxy.startProxy({ nodeIndex: idx })
          return json(res, 200, { ok: true, name: r.node.name, testOk: r.ok, error: r.error })
        } catch (err) {
          return json(res, 500, { error: err.message })
        }
      }

      if (req.method === 'POST' && p === '/api/proxy/speedtest') {
        const nodes = proxy.getNodes()
        if (!nodes.length) return json(res, 400, { error: '无节点，请先设置订阅' })
        const wasRunning = proxy.getStatus().running
        const curIdx = getConfig().proxy?.nodeIndex ?? 0
        const testUrl = getConfig().proxy?.testUrl || 'https://www.gstatic.com/generate_204'
        const results = []
        for (let i = 0; i < nodes.length; i++) {
          const n = nodes[i]
          try {
            await proxy.startProxy({ nodeIndex: i, skipTest: true })
            const t0 = Date.now()
            let ok = false
            try {
              const res = await fetchText(testUrl, { proxy: true, timeout: 5000 })
              ok = res.status >= 200 && res.status < 500
            } catch { ok = false }
            results.push({ idx: i, name: n.name, add: n.add, port: n.port, ok, ms: Date.now() - t0 })
          } catch (err) {
            results.push({ idx: i, name: n.name, add: n.add, port: n.port, ok: false, ms: 0, error: err.message })
          }
        }
        // 恢复原状态
        try {
          if (wasRunning) await proxy.startProxy({ nodeIndex: curIdx })
          else proxy.stopProxy()
        } catch { /* 恢复失败继续 */ }
        const okCount = results.filter(r => r.ok).length
        return json(res, 200, { results, ok_count: okCount, total: results.length })
      }

      return json(res, 404, { error: 'Not Found' })
    } catch (err) {
      return json(res, 500, { error: err.message })
    }
  })

  server.on('error', err => {
    console.error(`[X-plugin] 面板端口 ${port} 启动失败:`, err?.message)
    if (err?.code === 'EADDRINUSE') {
      console.error('[X-plugin] 端口被占用，可修改 data/config.json 的 panel.port 后重启云崽')
    }
  })

  server.listen(port, '0.0.0.0', () => {
    console.log(`[X-plugin] 面板已启动: http://0.0.0.0:${port}（token: ${token}）`)
  })
  return server
}

export function stop () {
  if (cleanupTimer) { clearInterval(cleanupTimer); cleanupTimer = null }
  if (server) {
    try { server.close() } catch { /* ignore */ }
    server = null
  }
}
