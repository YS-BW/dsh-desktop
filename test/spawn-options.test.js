'use strict'

/**
 * 结构化的防回归检查:每个 spawn 调用点都必须带 `windowsHide: true`。
 *
 * 为什么用源码扫描而不是行为测试:这个参数的作用是"不给 Windows 分配控制台窗口",
 * 它没有任何可断言的返回值 —— 只能靠真人在桌面上看有没有黑窗。而漏掉它的后果
 * (每次启动/升级都闪一个控制台窗口)又足够明显,所以这里退一步,至少保证
 * 「调用点和参数的数量对得上」,漏一个就红。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.join(__dirname, '..')

/** 会被打进 App 的、会派生进程的文件。 */
const FILES_WITH_SPAWNS = [
  'main.js',
  'updater.js',
  'plugin-installer.js',
  'diagnose.js'
]

test('every spawn site in the shipped sources hides the console window', () => {
  for (const file of FILES_WITH_SPAWNS) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8')
    const spawnSites = source.match(/\bspawn(?:Impl)?\s*\(/g) || []
    const hidden = source.match(/windowsHide:\s*true/g) || []
    assert.ok(
      hidden.length >= spawnSites.length,
      `${file}: ${spawnSites.length} 个 spawn 调用点，但只有 ${hidden.length} 处 windowsHide: true`
    )
  }
})

test('platform.js is the only place that builds command shims and tree kills', () => {
  // 这两件事一旦被复制回业务文件,Windows 的坑就又变成多份了
  const platform = fs.readFileSync(path.join(ROOT, 'platform.js'), 'utf8')
  assert.match(platform, /function killProcessTree/)
  assert.match(platform, /function commandShimScript/)

  for (const file of ['main.js', 'updater.js', 'plugin-installer.js', 'watchdog.js']) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8')
    // 只能引用 platform.js 的实现,不能自己 spawn taskkill(注释里提到它不算)
    assert.doesNotMatch(
      source,
      /spawn\w*\(\s*['"]taskkill/,
      `${file} 不该自己 spawn taskkill`
    )
    assert.doesNotMatch(source, /fs\.symlinkSync/, `${file} 不该再建符号链接`)
  }

  // 停止后端的两条路径都必须走进程树终止
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
  assert.match(main, /killProcessTree\(target\.pid/)
  const watchdog = fs.readFileSync(path.join(ROOT, 'watchdog.js'), 'utf8')
  assert.match(watchdog, /killProcessTree\(pid/)
})
