import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { getConfig, setConfig, DATA_DIR } from './config.js'
import { fetchText } from './fetch.js'

const NODES_PATH = path.join(DATA_DIR, 'nodes.json')
const V2RAY_CONFIG = path.join(DATA_DIR, 'v2ray.json')

let child = null
let nodes = []
let currentNode = null
let lastError = ''

/** 订阅解析 */

function parseVmess (b64) {
  try {
    const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))
    if (!json.add || !json.id) return null
    return {
      type: 'vmess',
      name: json.ps || json.add,
      add: json.add,
      port: Number(json.port || 443),
      id: json.id,
      aid: Number(json.aid ?? 0),
      net: json.net || 'tcp',
      host: json.host || '',
      path: json.path || '/',
      tls: !!json.tls
    }
  } catch { return null }
}

function parseVless (u) {
  try {
    const url = new URL(u.replace(/^vless:\/\//, 'http://'))
    const sec = url.searchParams.get('security') || ''
    return {
      type: 'vless',
      name: decodeURIComponent(url.hash.slice(1)) || url.hostname,
      add: url.hostname,
      port: Number(url.port || 443),
      id: decodeURIComponent(url.username),
      net: url.searchParams.get('type') || 'tcp',
      host: url.searchParams.get('host') || '',
      path: url.searchParams.get('path') || '/',
      tls: sec === 'tls' || sec === 'reality'
    }
  } catch { return null }
}

function parseTrojan (u) {
  try {
    const url = new URL(u.replace(/^trojan:\/\//, 'http://'))
    return {
      type: 'trojan',
      name: decodeURIComponent(url.hash.slice(1)) || url.hostname,
      add: url.hostname,
      port: Number(url.port || 443),
      password: decodeURIComponent(url.username),
      net: url.searchParams.get('type') || 'tcp',
      host: url.searchParams.get('host') || '',
      path: url.searchParams.get('path') || '/',
      tls: true
    }
  } catch { return null }
}

function parseSS (u) {
  try {
    let body = u.slice(5)
    let name = ''
    const hashIdx = body.indexOf('#')
    if (hashIdx >= 0) {
      name = decodeURIComponent(body.slice(hashIdx + 1))
      body = body.slice(0, hashIdx)
    }
    let cred = ''
    let hostport = ''
    const atIdx = body.lastIndexOf('@')
    if (atIdx >= 0) {
      cred = body.slice(0, atIdx)
      hostport = body.slice(atIdx + 1)
    } else {
      const dec = Buffer.from(body, 'base64').toString('utf8')
      const at2 = dec.lastIndexOf('@')
      cred = dec.slice(0, at2)
      hostport = dec.slice(at2 + 1)
    }
    let method = ''
    let password = ''
    if (cred.includes(':')) {
      ;[method, password] = cred.split(':')
    } else {
      ;[method, password] = Buffer.from(cred, 'base64').toString('utf8').split(':')
    }
    const [add, port] = hostport.split(':')
    if (!add || !method || !password) return null
    return {
      type: 'ss',
      name: name || add,
      add,
      port: Number(port || 443),
      method,
      password,
      net: 'tcp',
      host: '',
      path: '/',
      tls: false
    }
  } catch { return null }
}

/** 解析订阅文本 */
export function parseSubscription (text) {
  const out = []
  for (const link of String(text || '').split(/\s+/).filter(Boolean)) {
    let node = null
    if (link.startsWith('vmess://')) node = parseVmess(link.slice(8))
    else if (link.startsWith('vless://')) node = parseVless(link)
    else if (link.startsWith('trojan://')) node = parseTrojan(link)
    else if (link.startsWith('ss://')) node = parseSS(link)
    if (node) out.push(node)
  }
  return out
}

/** 订阅拉取 */

export async function refreshNodes () {
  const cfg = getConfig()
  const url = cfg.proxy.subscribeUrl
  if (!url) throw new Error('未配置订阅链接，请先执行 #X代理设置订阅 <链接>')
  const res = await fetchText(url, { timeout: 20000 })
  if (res.status !== 200 && res.status !== 0) throw new Error(`订阅拉取失败 HTTP ${res.status}`)
  let list = parseSubscription(res.body)
  if (!list.length) {
    // 整段解码
    try {
      const dec = Buffer.from(res.body.trim(), 'base64').toString('utf8')
      list = parseSubscription(dec)
    } catch { /* ignore */ }
  }
  if (!list.length) throw new Error('订阅解析失败：未识别到 vmess/vless/trojan/ss 节点')
  nodes = list
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(NODES_PATH, JSON.stringify(nodes, null, 2), { mode: 0o600 })
  return nodes
}

export function getNodes () {
  if (nodes.length) return nodes
  try {
    nodes = JSON.parse(fs.readFileSync(NODES_PATH, 'utf8'))
  } catch { nodes = [] }
  return nodes
}

/** 代理生命周期 */

function buildV2rayConfig (node, port) {
  const stream = { network: node.net || 'tcp' }
  if (stream.network === 'ws') {
    stream.wsSettings = { path: node.path || '/', headers: { Host: node.host || node.add } }
  }
  if (node.tls) stream.security = 'tls'
  const outbound = { protocol: node.type, settings: {}, streamSettings: stream }
  if (node.type === 'vmess') {
    outbound.settings.vnext = [{
      address: node.add, port: node.port,
      users: [{ id: node.id, alterId: node.aid ?? 0, security: 'auto' }]
    }]
  } else if (node.type === 'vless') {
    outbound.settings.vnext = [{
      address: node.add, port: node.port,
      users: [{ id: node.id, encryption: 'none' }]
    }]
  } else if (node.type === 'trojan') {
    outbound.settings.servers = [{
      address: node.add, port: node.port, password: node.password, level: 0
    }]
  } else if (node.type === 'ss') {
    outbound.settings.servers = [{
      address: node.add, port: node.port, method: node.method, password: node.password, level: 0
    }]
  } else {
    throw new Error(`不支持的节点协议: ${node.type}`)
  }
  return {
    log: { loglevel: 'warning' },
    inbounds: [{
      port, listen: '127.0.0.1', protocol: 'socks', settings: { udp: true }
    }],
    outbounds: [outbound]
  }
}

function findV2rayBin () {
  for (const p of ['/usr/bin/v2ray', '/usr/local/bin/v2ray', '/usr/bin/xray', '/usr/local/bin/xray']) {
    if (fs.existsSync(p)) return p
  }
  return 'v2ray'
}

function waitPort (port, timeoutMs, onDead) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const tryConn = () => {
      if (onDead()) return reject(new Error('v2ray 进程已退出'))
      const sock = net.connect(port, '127.0.0.1')
      sock.once('connect', () => { sock.destroy(); resolve() })
      sock.once('error', () => {
        sock.destroy()
        if (Date.now() > deadline) reject(new Error('v2ray 本地端口等待超时'))
        else setTimeout(tryConn, 250)
      })
    }
    tryConn()
  })
}

/** 同步等待 */
function sleepSync (ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch { /* ignore */ }
}

/** 清理孤儿 v2ray */
export function killStale () {
  try {
    const out = execFileSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' })
    for (const line of out.split('\n')) {
      if (!line.includes('X-plugin/data/v2ray.json')) continue
      const pid = parseInt(line.trim().split(/\s+/)[0], 10)
      if (pid && pid !== process.pid) {
        try { process.kill(pid, 'SIGKILL') } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  sleepSync(300)
}

/** 下一节点 */
export function nextNode () {
  const nodes = getNodes()
  const cur = getConfig().proxy?.nodeIndex ?? 0
  if (!nodes.length) return 0
  return (cur + 1) % nodes.length
}

/** 启动代理 */
export async function startProxy ({ nodeIndex, skipTest } = {}) {
  const cfg = getConfig()
  killStale()
  if (child) stopProxy()
  if (!getNodes().length) await refreshNodes()
  const list = getNodes()
  const idx = nodeIndex ?? cfg.proxy.nodeIndex ?? 0
  const node = list[idx]
  if (!node) throw new Error(`节点 #${idx} 不存在（共 ${list.length} 个节点）`)

  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(V2RAY_CONFIG, JSON.stringify(buildV2rayConfig(node, cfg.proxy.port), null, 2), { mode: 0o600 })

  const bin = findV2rayBin()
  await new Promise((resolve, reject) => {
    // 脱离进程组
    const proc = spawn(bin, ['-c', V2RAY_CONFIG], { stdio: 'ignore', detached: true })
    child = proc
    proc.unref()
    proc.on('error', (err) => {
      if (child === proc) child = null
      reject(new Error(`v2ray 启动失败: ${err.message}`))
    })
    proc.on('exit', () => { if (child === proc) child = null })
    waitPort(cfg.proxy.port, 8000, () => !child)
      .then(resolve)
      .catch(reject)
  })

  currentNode = { idx, ...node }
  let ok = true
  let error = ''
  if (!skipTest) {
    ok = await testProxy()
    error = lastError
  }
  setConfig({ proxy: { enabled: true, nodeIndex: idx } })
  return { node, ok, error }
}

export function stopProxy () {
  if (child) {
    const proc = child
    child = null
    try { proc.kill('SIGTERM') } catch { /* ignore */ }
    // 未退则强杀
    try {
      sleepSync(800)
      process.kill(proc.pid, 0)
      try { process.kill(proc.pid, 'SIGKILL') } catch { /* ignore */ }
    } catch { /* ignore */ }
    try { proc.removeAllListeners() } catch { /* ignore */ }
  }
  currentNode = null
  try { setConfig({ proxy: { enabled: false } }) } catch { /* ignore */ }
}

/** 测试连通性 */
export async function testProxy () {
  const cfg = getConfig()
  try {
    const res = await fetchText(cfg.proxy.testUrl || 'https://www.gstatic.com/generate_204', { proxy: true, timeout: 15000 })
    lastError = ''
    return res.status >= 200 && res.status < 500
  } catch (err) {
    lastError = err.message
    return false
  }
}

export function getStatus () {
  const cfg = getConfig()
  return {
    running: !!child,
    enabled: cfg.proxy.enabled,
    port: cfg.proxy.port,
    node: currentNode,
    nodeCount: getNodes().length,
    subscribeUrl: cfg.proxy.subscribeUrl
      ? cfg.proxy.subscribeUrl.replace(/token=([^&\s]+)/i, 'token=***')
      : ''
  }
}
