// 浏览器拦截GraphQL响应
// 认证头绕cf
import { createRequire } from 'node:module'
import { getConfig } from './config.js'

const require2 = createRequire('/QQBOT/Yunzai/')
const puppeteer = require2('puppeteer')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

let busy = null

/** 单浏览器互斥 */
function acquire () {
  const prev = busy || Promise.resolve()
  let release
  busy = new Promise(r => { release = r })
  return prev.then(() => release)
}

function sleep (ms) { return new Promise(r => setTimeout(r, ms)) }

/**
 * 打开X页拦截GraphQL响应
 * @param {string} path 页面路径，如 '/i/status/123'、'/hypefury'、'/search?q=x&f=live'
 * @param {string[]} ops 要拦截的 operationName 列表
 * @param {object} [opts] { timeout, gotoTimeout }
 * @returns {Promise<Record<string, any>>} { [opName]: JSON 对象 }
 */
export async function graphQLByBrowser (path, ops, { timeout = 55000, gotoTimeout = 45000 } = {}) {
  const release = await acquire()
  const cfg = getConfig()
  const cookie = cfg.x?.cookie || ''
  const external = cfg.proxy?.externalUrl || ''
  const proxyServer = external
    ? String(external).replace(/^socks5h:\/\//i, 'socks5://')
    : `socks5://127.0.0.1:${cfg.proxy?.port || 10890}`
  let browser
  try {
    browser = await puppeteer.launch({
      executablePath: '/usr/bin/chromium',
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--headless=new',
        `--proxy-server=${proxyServer}`,
        '--disable-blink-features=AutomationControlled',
        '--window-size=1280,900'
      ]
    })
    const page = await browser.newPage()
    await page.setUserAgent(UA)
    if (cookie) {
      const cookies = String(cookie).split('; ').filter(Boolean).map(seg => {
        const i = seg.indexOf('=')
        return { name: seg.slice(0, i), value: seg.slice(i + 1), domain: '.x.com', path: '/' }
      })
      if (cookies.length) await page.setCookie(...cookies)
    }
    const hits = {}
    page.on('response', async (res) => {
      const u = res.url()
      if (!u.includes('/i/api/graphql/')) return
      const m = u.match(/graphql\/[A-Za-z0-9_-]+\/([A-Za-z0-9_]+)/)
      if (!m || !ops.includes(m[1])) return
      if (hits[m[1]]) return
      try {
        const text = await res.text()
        if (res.status() === 200 && text) {
          const j = JSON.parse(text)
          hits[m[1]] = j
        } else {
          hits[m[1]] = { _status: res.status() }
        }
      } catch { /* 忽略解析失败 */ }
    })
    await page.goto('https://x.com' + path, { waitUntil: 'networkidle2', timeout: gotoTimeout }).catch(() => { /* 超时仍等数据 */ })
    // 等目标 op 到齐或超时
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const got = ops.filter(o => hits[o])
      if (got.length >= ops.length) break
      await sleep(500)
    }
    return hits
  } finally {
    if (browser) { try { await browser.close() } catch { /* ignore */ } }
    release()
  }
}

/** 检查 Cookie 有效性（浏览器登录态） */
export async function checkCookieByBrowser () {
  const cfg = getConfig()
  const cookie = cfg.x?.cookie || ''
  if (!cookie) return { ok: false, msg: '未配置 Cookie' }
  let screenName = ''
  try {
    const hits = await graphQLByBrowser('/home', ['HomeTimeline'], { timeout: 30000 })
    if (hits.HomeTimeline && hits.HomeTimeline._status !== 401) {
      // 取账号名
      try {
        const v = hits.HomeTimeline?.data?.viewer?.user_results?.result?.legacy || hits.HomeTimeline?.data?.home?.home_timeline_urt?.user_results?.result?.legacy
        screenName = v?.screen_name || ''
      } catch { /* ignore */ }
      return { ok: true, msg: `✅ 有效（账号 ${screenName || '已登录'}）` }
    }
    return { ok: false, msg: '❌ 无效（浏览器会话未通过）——请重新复制 Cookie' }
  } catch (err) {
    return { ok: false, msg: `❌ 检查失败：${err.message}` }
  }
}
