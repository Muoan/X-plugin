import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const DATA_DIR = path.join(PLUGIN_DIR, 'data')
const CONFIG_PATH = path.join(DATA_DIR, 'config.json')

const DEFAULTS = {
  proxy: {
    // 订阅链接
    subscribeUrl: '',
    // 代理端口
    port: 10890,
    enabled: false,
    // 节点序号
    nodeIndex: 0,
    // 测试地址
    testUrl: 'https://www.gstatic.com/generate_204'
  },
  x: {
    // 解析接口
    apiBase: 'https://api.fxtwitter.com',
    // 失败走代理
    useProxyFallback: true,
    // 自动下载直链
    autoDownload: true,
    // X 账号 Cookie
    cookie: '',
    // 评论接口 ID
    tweetDetailQueryId: ''
  },
  panel: {
    // 面板端口
    port: 3007,
    // 登录令牌
    token: '',
    // 面板标题
    title: 'X 下载面板',
    // 直链有效期
    cleanupMinutes: 60,
    // 文件上限
    maxFileMB: 500,
    // 公网地址
    publicUrl: ''
  }
}

function deepMerge (base, patch) {
  for (const k of Object.keys(patch || {})) {
    if (patch[k] && typeof patch[k] === 'object' && !Array.isArray(patch[k]) &&
        base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      deepMerge(base[k], patch[k])
    } else {
      base[k] = patch[k]
    }
  }
  return base
}

export function getConfig () {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8')
    return deepMerge(structuredClone(DEFAULTS), JSON.parse(raw))
  } catch {
    return structuredClone(DEFAULTS)
  }
}

export function setConfig (patch) {
  const next = deepMerge(getConfig(), patch)
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), { mode: 0o600 })
  return next
}

export { PLUGIN_DIR, DATA_DIR }
