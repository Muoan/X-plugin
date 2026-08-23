import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { getConfig, setConfig, DATA_DIR, PLUGIN_DIR } from './config.js'
import { extractXUrl, getTweet, buildXMessage, formatMedia } from './x.js'
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

export function getTask (id) {
  const key = String(id)
  return tasks.get(key) || [...tasks.values()].find(t => t.code === key) || null
}

export function createTask (url, { kind, name } = {}) {
  const task = makeTask(url, kind, name)
  tasks.set(String(task.id), task)
  kickTaskWorker()
  return task
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
  if (t.file_id) {
    const f = findFileById(t.file_id)
    if (f) fs.rmSync(f, { force: true })
    fileKeys.delete(String(t.file_id))
  }
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

/** 挑最佳资源 */
function pickFromTweet (tweet) {
  const media = tweet.media?.all || []
  for (const item of media) {
    if (item.type === 'video' || item.type === 'gif') {
      const variants = (item.variants || [])
        .filter(v => (v.content_type || '').includes('mp4'))
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))
      if (variants[0]?.url) return { url: variants[0].url, kind: item.type === 'gif' ? 'GIF' : '视频' }
    }
  }
  for (const item of media) {
    if (item.type === 'image' && item.url) return { url: item.url, kind: '图片' }
  }
  return null
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

function sendText (res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end(text)
}

const MIME = {
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.zip': 'application/zip'
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
              const pick = pickFromTweet(tweet)
              if (!pick) return json(res, 400, { error: '该推文没有可下载的视频/图片资源' })
              dlUrl = pick.url
              kind = pick.kind
              name = tweet.author?.screen_name ? `@${tweet.author.screen_name}` : ''
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
            node_index: cfg.proxy?.nodeIndex ?? 0
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
            if (Object.keys(ppatch).length) setConfig({ proxy: ppatch })
          }
          const proxyPortChanged = !!(body.proxy?.port !== undefined && Number(body.proxy.port) !== oldProxyPort)
          const portChanged = !!(body.port !== undefined && Number(body.port) !== port)
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
