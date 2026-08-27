import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import chalk from 'chalk'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const name = path.basename(__dirname)
const start = Date.now()

const apps = {}
const files = []
let ok = 0
let fail = 0

function walk (dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p)
    else if (entry.name.endsWith('.js')) files.push(p)
  }
}

try {
  walk(path.join(__dirname, 'apps'))
  await Promise.all(files.map(async (file) => {
    try {
      const mod = await import(pathToFileURL(file).href)
      const key = path.basename(file, '.js')
      apps[key] = mod.default || mod[Object.keys(mod)[0]]
      ok++
    } catch (err) {
      fail++
      logger?.error?.(`[${name}] 载入 ${path.basename(file)} 错误：`, err)
    }
  }))
} catch (err) {
  logger?.error?.(`[${name}] 载入插件时发生错误：`, err)
}

const cost = Date.now() - start
const line = '-'.repeat(30)
const colors = [chalk.cyanBright.bold, chalk.greenBright.bold, chalk.magentaBright.bold, chalk.yellowBright.bold]
logger?.info?.(line)
const msgs = [
  `${name} 加载完成 (*^▽^*)`,
  `成功 ${ok} 个，失败 ${fail} 个`,
  `✅  总耗时: ${cost} ms`
]
msgs.forEach((msg, i) => logger?.info?.(colors[i % colors.length](msg)))
logger?.info?.(line)

// 启动面板
try {
  const panel = await import('./components/panel.js')
  panel.start()
} catch (err) {
  logger?.error?.(`[${name}] 面板启动失败：`, err)
}

export { apps }
