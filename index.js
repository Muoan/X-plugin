import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import chalk from 'chalk'
import { getConfig } from './components/config.js'

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
// 启动横幅
const line = chalk.gray('-'.repeat(30))
const port = getConfig().panel?.port || 3007
const bootLines = [
  line,
  `${chalk.cyanBright.bold(name)} ${chalk.greenBright.bold('v1.0.0')} ${chalk.cyanBright.bold('加载完成 (*^▽^*)')}`,
  `  ${chalk.yellow('成功')} ${chalk.whiteBright.bold(ok)} ${chalk.yellow('个，失败')} ${chalk.whiteBright.bold(fail)} ${chalk.yellow('个')}`,
  `${chalk.greenBright('✅ 总耗时:')} ${chalk.whiteBright(cost)} ms`,
  `${chalk.greenBright('🚀 面板已启动:')} http://0.0.0.0:${port}`,
  line
]
console.log('\n' + bootLines.join('\n') + '\n')

// 启动面板
try {
  const panel = await import('./components/panel.js')
  panel.start()
} catch (err) {
  logger?.error?.(`[${name}] 面板启动失败：`, err)
}

export { apps }
