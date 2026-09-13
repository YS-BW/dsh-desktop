'use strict'

/**
 * 打包契约测试。
 *
 * 为什么需要：这几条都是**只在打包产物里才会暴露**的约束 —— 开发态（npm start）
 * 一切正常，装出来却起不来。最典型的一次实测：
 *
 *   引擎的插件在 lockfile 里是 peerDependencies，而 electron-builder 的依赖收集器
 *   只跟 dependencies，于是 24 个 @deepseek-ai/* 包没进安装包（包括 dsh-app-boot
 *   无条件 import 的 @deepseek-ai/cordis-plugin-group）。更阴的是：
 *   `release/win-unpacked` 放在仓库里时，Node 的模块解析会向上回溯命中仓库开发态的
 *   node_modules，看起来完全正常；装到程序目录后才报 ERR_MODULE_NOT_FOUND。
 *
 * 所以这些约束必须有测试钉住，否则一次“配置清理”就会把它退回原样。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.join(__dirname, '..')
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8')

test('the whole engine tree is copied verbatim, not collected by dependency walking', () => {
  const yml = read('electron-builder.yml')

  // 引擎整棵走 extraResources 原样拷贝
  assert.match(yml, /^extraResources:/m, '必须用 extraResources 拷贝引擎整棵树')
  assert.match(
    yml,
    /to:\s*app\/node_modules\/@deepseek-ai/,
    '拷贝目标必须是 resources/app/node_modules/@deepseek-ai'
  )
  // files 里必须排除它，否则会被拷两遍（体积翻倍）
  assert.match(
    yml,
    /"!node_modules\/@deepseek-ai\/\*\*"/,
    'files 里要排除 @deepseek-ai，避免重复拷贝'
  )
  // 依赖重建必须关掉：这个 App 里 Electron 自己不加载原生模块，
  // 按 Electron ABI 重建反而会让引擎在真 node 下加载失败。
  assert.match(yml, /^npmRebuild:\s*false$/m)
})

test('every module the shell requires at runtime is listed in the package files', () => {
  const yml = read('electron-builder.yml')
  const filesBlock = yml.slice(yml.indexOf('files:'), yml.indexOf('extraMetadata:'))
  const listed = new Set(
    [...filesBlock.matchAll(/^\s*-\s*"?([^"#\s][^"\n]*?)"?\s*$/gm)].map((m) => m[1].trim())
  )

  // 只在打包态会被加载的入口文件
  const entries = ['main.js', 'updater.js', 'plugin-installer.js', 'notify.js', 'watchdog.js']
  const required = new Set()
  for (const entry of [...entries, 'platform.js', 'output-lines.js']) {
    const source = read(entry)
    for (const match of source.matchAll(/require\(['"]\.\/([\w.-]+)['"]\)/g)) {
      required.add(match[1])
    }
  }

  assert.ok(required.size >= 4, '应该扫到若干本地模块依赖')
  for (const dep of required) {
    // require('./updater') 对应清单里的 updater.js
    const candidates = [dep, `${dep}.js`, `${dep}.cjs`, `${dep}.mjs`]
    assert.ok(
      candidates.some((candidate) => listed.has(candidate)),
      `${dep} 被 require 了，但不在 electron-builder.yml 的 files 列表里 —— 打包版会启动即崩`
    )
  }
  // 反向检查：列出来的本地模块确实存在（防拼写错误）
  for (const file of listed) {
    if (!file.endsWith('.js')) continue
    if (file === 'package.json' || file.startsWith('!')) continue
    assert.ok(fs.existsSync(path.join(ROOT, file)), `files 里列了不存在的文件：${file}`)
  }
})

test('the Desktop directory-picker overlay is shipped with the app', () => {
  const yml = read('electron-builder.yml')
  assert.match(
    yml,
    /^\s*-\s*desktop-directory-picker\.patch\.yml\s*$/m,
    '启动 DSH 时传入的目录选择器覆盖层必须进入安装包'
  )
  assert.ok(
    fs.existsSync(path.join(ROOT, 'desktop-directory-picker.patch.yml')),
    '目录选择器覆盖层文件必须存在'
  )
})

test('Windows packaging keeps the notification prerequisite', () => {
  const yml = read('electron-builder.yml')
  // Windows toast 需要 AppUserModelID + 开始菜单快捷方式；
  // 快捷方式是 NSIS 安装包建的，portable 包不会建 —— 所以必须出 nsis。
  assert.match(yml, /^win:/m)
  assert.match(yml, /target:\s*nsis/)
  assert.match(yml, /createStartMenuShortcut:\s*true/)
  // 每用户安装：不需要管理员权限（正是原先卡住插件向导的那类环境）
  assert.match(yml, /perMachine:\s*false/)
})

test('macOS targets are untouched by the Windows port', () => {
  const yml = read('electron-builder.yml')
  // 加平台不能顺手把 mac 的构建方式改掉
  assert.match(yml, /target:\s*dmg/)
  assert.match(yml, /arch:\s*\[arm64\]/)
  assert.match(yml, /icon:\s*build\/icon\.icns/)
  // ad-hoc 签名是 macOS 通知能投递的前提，必须保留
  assert.match(yml, /identity:\s*'-'/)
  assert.match(yml, /asar:\s*false/)
})
