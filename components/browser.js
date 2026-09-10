// 浏览器拦截GraphQL响应
// 认证头绕cf
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { getConfig } from './config.js'

const require2 = createRequire(import.meta.url)
let puppeteerCache = null
let puppeteerName = ''

/** 惰性加载依赖 */
function loadPuppeteer () {
  if (puppeteerCache) return puppeteerCache
  for (const name of ['puppeteer', 'puppeteer-core']) {
    try {
      puppeteerCache = require2(name)
      puppeteerName = name
      return puppeteerCache
    } catch { /* 试下一个 */ }
  }
  throw new Error('缺少依赖 puppeteer，请在云崽根目录执行 pnpm add puppeteer（或 npm i puppeteer）后重启')
}

/** 探测浏览器路径 */
function findChrome (custom) {
  const list = [
    custom,
    process.env.CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/snap/bin/chromium'
  ].filter(Boolean)
  for (const p of list) {
    if (existsSync(p)) return p
  }
  for (const bin of ['chromium', 'chromium-browser', 'google-chrome', 'chrome']) {
    try {
      const p = execFileSync('which', [bin], { encoding: 'utf8' }).trim()
      if (p && existsSync(p)) return p
    } catch { /* 未安装 */ }
  }
  return ''
}

/** 启动前自检 */
function assertBrowser () {
  const puppeteer = loadPuppeteer()
  const p = findChrome(getConfig().browser?.executablePath)
  if (!p && puppeteerName === 'puppeteer-core') {
    throw new Error('puppeteer-core 需要系统浏览器，请安装 chromium 或在配置里填 browser.executablePath')
  }
  return { puppeteer, executablePath: p }
}

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
  const { puppeteer, executablePath } = assertBrowser()
  let browser
  try {
    browser = await puppeteer.launch({
      ...(executablePath ? { executablePath } : {}),
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

/** 浏览器环境自检 */
export function browserReady () {
  try {
    const { executablePath } = assertBrowser()
    return { ok: true, msg: `✅ 浏览器可用（${executablePath || 'puppeteer 自带 Chrome'}）`, module: puppeteerName }
  } catch (err) {
    return { ok: false, msg: err.message, module: puppeteerName }
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
