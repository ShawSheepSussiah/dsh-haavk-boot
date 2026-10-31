#!/usr/bin/env node
/**
 * 安装后自动把本插件写进 DSH profile 的 dsh.profile.bundles。
 *
 * 为什么需要：
 *   `dsh plugin add` 只是把 pnpm add 转发给 profile 目录，
 *   pnpm 只写 node_modules 和 dependencies，绝不碰 dsh.profile.bundles。
 *   而 DSH 的 loader 只认 bundles —— 没有这一行，插件永远不会被加载。
 *
 * 注意：
 *   - 在插件仓库里跑 `pnpm install` 时，找不到 profile，直接安静退出。
 *   - 幂等：已经在 bundles 里就不再写。
 */

import fs from 'node:fs'
import path from 'node:path'

const PLUGIN_NAME = 'dsh-haavk-boot'

function readJson(fp) {
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'))
  } catch {
    return null
  }
}

function isProfilePkg(pkg) {
  if (!pkg || typeof pkg !== 'object') return false
  if (typeof pkg.name === 'string' && pkg.name.startsWith('dsh-profile-')) return true
  return Array.isArray(pkg?.dsh?.profile?.bundles)
}

function findProfileDir() {
  const seeds = [process.env.INIT_CWD, process.env.npm_config_local_prefix, process.cwd()].filter(Boolean)
  for (const seed of seeds) {
    let dir = path.resolve(seed)
    for (let i = 0; i < 10; i += 1) {
      if (isProfilePkg(readJson(path.join(dir, 'package.json')))) return dir
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return ''
}

function main() {
  const profileDir = findProfileDir()
  if (!profileDir) {
    // 在插件仓库或普通项目里安装，无需处理
    return
  }

  const fp = path.join(profileDir, 'package.json')
  const pkg = readJson(fp)
  if (!pkg) return

  const profile = pkg.dsh?.profile
  if (!profile || !Array.isArray(profile.bundles)) return

  if (profile.bundles.includes(PLUGIN_NAME)) {
    process.stdout.write(`dsh-haavk-boot: already in bundles (${profileDir})\n`)
    return
  }

  // 追加到末尾：顺序即加载顺序，@deepseek-ai/dsh-base 等框架包必须先加载
  profile.bundles.push(PLUGIN_NAME)

  try {
    fs.writeFileSync(fp, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
    process.stdout.write(`dsh-haavk-boot: added to bundles (${profileDir})\n`)
    process.stdout.write('dsh-haavk-boot: 请完全退出 DSH 再重新打开，启动屏才会生效\n')
  } catch (error) {
    process.stderr.write(`dsh-haavk-boot: 写入 ${fp} 失败: ${error?.message ?? error}\n`)
    process.exit(1)
  }
}

main()
