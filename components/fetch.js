import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getConfig } from './config.js'

/** 统一抓取 */
export async function fetchText (url, { proxy = false, timeout = 15000, headers = {} } = {}) {
  if (proxy) return curlFetch(url, { timeout, headers })
  return nodeFetch(url, { timeout, headers })
}

async function nodeFetch (url, { timeout, headers }) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers })
    const body = await res.text()
    return {
      status: res.status,
      body,
      url: res.url || url,
      contentType: res.headers.get('content-type') || '',
      contentLength: res.headers.get('content-length') || ''
    }
  } catch (err) {
    err.message = `直连失败: ${err.message}`
    throw err
  } finally {
    clearTimeout(timer)
  }
}

function curlFetch (url, { timeout, headers }) {
  const cfg = getConfig()
  const external = cfg.proxy?.externalUrl || ''
  const proxyArg = external || `socks5h://127.0.0.1:${cfg.proxy?.port || 10890}`
  const tmpBody = path.join(os.tmpdir(), `xplug_body_${Date.now()}_${Math.random().toString(36).slice(2)}.tmp`)
  const tmpHdr = path.join(os.tmpdir(), `xplug_hdr_${Date.now()}_${Math.random().toString(36).slice(2)}.tmp`)
  const args = [
    '-s', '-L',
    '-m', String(Math.max(1, Math.floor(timeout / 1000))),
    '-x', proxyArg,
    '-D', tmpHdr,
    '-o', tmpBody,
    '-w', '%{http_code}'
  ]
  for (const [k, v] of Object.entries(headers || {})) args.push('-H', `${k}: ${v}`)
  args.push(url)
  return new Promise((resolve, reject) => {
    execFile('curl', args, { timeout: timeout + 5000 }, (err, stdout) => {
      const cleanup = () => { fs.rmSync(tmpBody, { force: true }); fs.rmSync(tmpHdr, { force: true }) }
      if (err) {
        cleanup()
        return reject(new Error(`代理请求失败: ${err.message}`))
      }
      let body = ''
      try { body = fs.readFileSync(tmpBody, 'utf8') } catch { /* binary */ }
      let contentType = ''
      let contentLength = ''
      try {
        const hdr = fs.readFileSync(tmpHdr, 'utf8')
        const m = hdr.match(/content-type:\s*([^\r\n]+)/i)
        if (m) contentType = m[1].trim()
        const l = hdr.match(/content-length:\s*([^\r\n]+)/i)
        if (l) contentLength = l[1].trim()
      } catch { /* ignore */ }
      cleanup()
      resolve({ status: Number(stdout.trim() || 0), body, url, contentType, contentLength })
    })
  })
}
