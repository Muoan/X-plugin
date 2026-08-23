import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { getConfig, DATA_DIR } from './config.js'
import * as proxy from './proxy.js'

const execFileAsync = promisify(execFile)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

/** curl 退出码转原因 */
function curlErr (code) {
  const map = {
    7: '连接失败（代理未启动或节点失效）',
    18: '传输中断（节点连接不稳定）',
    22: '链接失效或 404',
    28: '下载超时',
    35: 'SSL 握手失败（节点异常）',
    52: '服务器无响应',
    55: '连接被重置（节点异常）',
    56: '接收数据失败'
  }
  return map[code] ? `${map[code]}（curl ${code}）` : `curl ${code}`
}

/** 自动起代理 */
export async function ensureProxy (needProxy, owner = 'download') {
  if (!needProxy) return false
  if (proxy.getStatus().running) return false
  try {
    await proxy.startProxy({ skipTest: true, owner })
    return true
  } catch (err) {
    const msg = String(err?.message || err)
    if (/未配置订阅/.test(msg)) {
      throw new Error('未配置代理订阅，请先 #X代理设置订阅 <链接>')
    }
    throw new Error(`代理启动失败：${msg}`)
  }
}

export const DOWNLOAD_DIR = path.join(DATA_DIR, 'downloads')

/** 生成 ma-id */
export function maId () {
  return `ma-${crypto.randomBytes(3).toString('hex')}`
}

/** 类型转扩展名 */
export function extFromType (ct) {
  const m = String(ct || '').match(/^\s*([\w.+-]+)\s*\//)
  const map = {
    'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'video/x-m4v': '.m4v',
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp'
  }
  return map[String(ct || '').toLowerCase().split(';')[0].trim()] || ''
}

/** 链接转扩展名 */
export function extFromUrl (url) {
  const m = String(url).match(/\.(mp4|webm|mov|m4v|jpg|jpeg|png|gif|webp|gifv)(?=[?#]|$)/i)
  return m ? `.${m[1].toLowerCase()}` : ''
}

/** 可否在线预览 */
export function canPreview (ext) {
  return /^\.(mp4|webm|mov|jpg|jpeg|png|gif|webp)$/i.test(ext || '')
}

/** 网络类错误 */
function isNetErr (msg) {
  return /curl (7|18|28|35|52|55|56)\b/.test(msg)
}

/** 换节点重连 */
async function failover () {
  try { proxy.stopProxy() } catch { /* ignore */ }
  await proxy.startProxy({ nodeIndex: proxy.nextNode(), skipTest: true })
}

/** 下载直链 */
export async function downloadFile (url, { useProxy = true, maxMB = 500, id } = {}) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true })

  // 被墙自动代理
  const needProxy = useProxy || /twimg\.com|twitter\.com|x\.com/i.test(url)
  const autoStarted = await ensureProxy(needProxy)
  try {
    return await attemptFile(url, { needProxy, maxMB, id }, 3)
  } finally {
    if (autoStarted) proxy.stopProxy()
  }
}

async function attemptFile (url, { needProxy, maxMB, id }, tries) {
  try {
    return await fileOnce(url, maxMB, id)
  } catch (err) {
    if (needProxy && isNetErr(err.message) && tries > 1) {
      await failover()
      return attemptFile(url, { needProxy, maxMB, id }, tries - 1)
    }
    throw err
  }
}

async function fileOnce (url, maxMB, wantId) {
  const cfg = getConfig()
  const id = wantId || maId()
  const ext = extFromUrl(url) || '.bin'
  const tmp = path.join(DOWNLOAD_DIR, `tmp_${id}${ext}`)
  const final = path.join(DOWNLOAD_DIR, `${id}${ext}`)
  const maxBytes = (maxMB || 500) * 1024 * 1024

  const args = ['-sL', '--fail', '--connect-timeout', '20', '-m', '900', '-A', UA, '-o', tmp]
  if (proxy.getStatus().running) {
    args.push('--socks5-hostname', `127.0.0.1:${cfg.proxy.port || 10890}`)
  }
  args.push(url)

  try {
    await execFileAsync('curl', args)
  } catch (err) {
    fs.rmSync(tmp, { force: true })
    const code = err?.code
    throw new Error(`下载失败：${code ? curlErr(code) : (err?.message || 'curl 错误')}`)
  }

  let size = 0
  try { size = fs.statSync(tmp).size } catch { /* ignore */ }
  if (size > maxBytes) {
    fs.rmSync(tmp, { force: true })
    throw new Error(`文件过大(${(size / 1048576).toFixed(1)}MB)，超过限制 ${maxMB}MB`)
  }
  if (size === 0) {
    fs.rmSync(tmp, { force: true })
    throw new Error('下载失败：文件为空（可能链接失效或需要代理）')
  }

  fs.renameSync(tmp, final)
  return { id, path: final, size, ext }
}

/** 删除过期文件 */
export function cleanupExpired (ttlMin = 60) {
  try {
    const cutoff = Date.now() - ttlMin * 60 * 1000
    for (const name of fs.readdirSync(DOWNLOAD_DIR)) {
      if (name.startsWith('tmp_')) {
        fs.rmSync(path.join(DOWNLOAD_DIR, name), { force: true })
        continue
      }
      const p = path.join(DOWNLOAD_DIR, name)
      const st = fs.statSync(p)
      if (st.mtimeMs < cutoff) fs.rmSync(p, { force: true })
    }
  } catch { /* ignore */ }
}

/** 启动清理 */
export function cleanupOnStart () {
  try {
    for (const name of fs.readdirSync(DOWNLOAD_DIR)) {
      fs.rmSync(path.join(DOWNLOAD_DIR, name), { force: true })
    }
  } catch { /* ignore */ }
}

function proxyArgs () {
  const cfg = getConfig()
  if (proxy.getStatus().running) {
    return ['--socks5-hostname', `127.0.0.1:${cfg.proxy.port || 10890}`]
  }
  return []
}

/** HEAD 探测 */
export function headInfo (url) {
  return new Promise((resolve) => {
    execFile('curl', ['-sIL', '--max-time', '30', '--connect-timeout', '15', '-A', UA, ...proxyArgs(), '-o', '/dev/null', '-D', '-', url],
      { timeout: 35000 },
      (err, stdout) => {
        if (err) return resolve(null)
        const text = String(stdout || '')
        const len = (text.match(/content-length:\s*(\d+)/i) || [])[1]
        const ct = (text.match(/content-type:\s*([^\r\n]+)/i) || [])[1]
        resolve({ size: len ? Number(len) : 0, type: ct ? ct.trim() : '' })
      })
  })
}

/** 带进度下载 */
export function downloadWithProgress (url, { onProgress, maxMB = 500, useProxy = true, id } = {}) {
  return new Promise((resolve, reject) => {
    ;(async () => {
      fs.mkdirSync(DOWNLOAD_DIR, { recursive: true })

      const autoStarted = await ensureProxy(useProxy)
      try {
        const r = await attemptProgress(url, { onProgress, maxMB, id }, 3)
        resolve(r)
      } catch (err) {
        reject(err)
      } finally {
        if (autoStarted) proxy.stopProxy()
      }
    })().catch(reject)
  })
}

async function attemptProgress (url, { onProgress, maxMB, id }, tries) {
  try {
    return await progressOnce(url, { onProgress, maxMB, id })
  } catch (err) {
    if (tries > 1 && isNetErr(err.message)) {
      await failover()
      return attemptProgress(url, { onProgress, maxMB, id }, tries - 1)
    }
    throw err
  }
}

function progressOnce (url, { onProgress, maxMB, id: wantId }) {
  return new Promise((resolve, reject) => {
    ;(async () => {
      const cfg = getConfig()
      const head = await headInfo(url)
      const total = head?.size || 0
      const id = wantId || maId()
      const ext = extFromUrl(url) || extFromType(head?.type) || '.bin'
      const tmp = path.join(DOWNLOAD_DIR, `tmp_${id}${ext}`)
      const final = path.join(DOWNLOAD_DIR, `${id}${ext}`)
      const maxBytes = (maxMB || 500) * 1024 * 1024

      const args = ['-sL', '--fail', '--connect-timeout', '20', '-m', '900', '-A', UA, ...proxyArgs(), '-o', tmp, url]
      const child = spawn('curl', args, { stdio: 'ignore' })

      let timer = null
      if (onProgress) {
        timer = setInterval(() => {
          try {
            const done = fs.statSync(tmp).size
            onProgress({ done, total })
          } catch { /* tmp 未创建 */ }
        }, 500)
      }

      let result = null
      await new Promise((res, rej) => {
        child.on('error', (err) => {
          if (timer) clearInterval(timer)
          fs.rmSync(tmp, { force: true })
          rej(new Error(`下载失败：${err.message}`))
        })
        child.on('close', (code) => {
          if (timer) clearInterval(timer)
          if (code !== 0) {
            fs.rmSync(tmp, { force: true })
            return rej(new Error(`下载失败：${curlErr(code)}`))
          }
          let size = 0
          try { size = fs.statSync(tmp).size } catch { /* ignore */ }
          if (size === 0) {
            fs.rmSync(tmp, { force: true })
            return rej(new Error('下载失败：文件为空'))
          }
          if (size > maxBytes) {
            fs.rmSync(tmp, { force: true })
            return rej(new Error(`文件过大(${(size / 1048576).toFixed(1)}MB)，超过限制 ${maxMB}MB`))
          }
          fs.renameSync(tmp, final)
          result = { id, path: final, size, ext }
          res()
        })
      })
      resolve(result)
    })().catch(reject)
  })
}
