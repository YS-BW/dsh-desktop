'use strict'

/**
 * **macOS 防退化测试** —— 在一台 Windows 机器上模拟 darwin 跑一遍。
 *
 * 为什么必须有这个文件：这次改造是「加 Windows 兼容」，最容易出的错不是 Windows
 * 跑不起来，而是**顺手把 macOS 原有的行为改掉**（少注入一次红绿灯留白、菜单少了
 * appMenu、POSIX 信号语义被 Windows 的 taskkill 逻辑顶掉……）。而这些分支在本机
 * 永远不会被执行到 —— 一个 if 写反了，本机的测试照样全绿。
 *
 * 所以这里在 require 任何模块之前把 `process.platform` 改写成 'darwin'：
 *   · platform.js 里模块级的 `isWindows` 会跟着变；
 *   · main.js 里所有 `process.platform` 判断（窗口形态、菜单、AUMID、拖拽区）也走 mac 分支。
 *
 * 边界：`node:path` 的分隔符是**它自己被加载时**定下的，而 node:test 通常已经先加载过，
 * 所以这里的 `path` 可能仍是 win32 语义。因此断言只针对**分支选择**，不针对路径格式。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { after, before } = require('node:test')

// ── 必须先改写平台，再 require 任何被测模块 ──────────────────────────────
Object.defineProperty(process, 'platform', {
  value: 'darwin',
  configurable: true,
  writable: false
})

const { bootMain } = require('./helpers/electron-stub')
const { killProcessTree, envPath, setEnvPath, executableExtensions, PATH_KEY } = require('../platform')

let booted
before(async () => {
  booted = await bootMain({ platform: 'darwin' })
})
after(() => booted?.cleanup())

test('platform layer reports itself as POSIX under the darwin simulation', () => {
  assert.equal(process.platform, 'darwin')
  assert.equal(PATH_KEY, 'PATH', 'macOS 上用 PATH，不是 Windows 的 Path')
  assert.deepEqual(executableExtensions(), [''], 'macOS 没有 PATHEXT 这一套')
})

test('process tree kill stays POSIX — no taskkill on macOS', () => {
  const calls = []
  const spawnImpl = (command, argv, options) => {
    calls.push({ command, argv, options })
    return { unref: () => {} }
  }

  // Windows 上这个函数负责 taskkill /t；macOS 上必须完全不介入，
  // 把「先 SIGTERM 排空、7 秒后 SIGKILL」的原有阶梯留给调用方。
  assert.equal(killProcessTree(1234, { spawnImpl }), false)
  assert.deepEqual(calls, [], 'macOS 上不能去 spawn taskkill')
})

test('PATH is written with the POSIX key and leaves no stray casing variant', () => {
  const env = { Path: 'stale-windows-key' }
  setEnvPath(env, '/usr/local/bin:/usr/bin')
  assert.equal(envPath(env), '/usr/local/bin:/usr/bin')
  assert.equal(env.Path, undefined, '写入 PATH 时应清掉其它大小写变体')
  assert.deepEqual(Object.keys(env), ['PATH'])
})

test('boot chain settles under the darwin simulation too', () => {
  assert.equal(booted.settled, true, '模拟 darwin 时启动链也必须走到报错 + 退出')
  assert.equal(booted.calls.errorBoxes.length, 1)
  assert.equal(booted.calls.errorBoxes[0].message, '启动 dsh 失败')
})

test('window keeps the frameless macOS shape', () => {
  const options = booted.windows[0].options
  // titleBarStyle: hidden + 无边框 + 内容延伸到顶部 —— 这是 macOS 观感的基础
  assert.equal(options.frame, false)
  assert.equal(options.titleBarStyle, 'hidden')
  assert.equal(options.webPreferences.sandbox, true)
  // Windows 那套「收起菜单栏 + 系统按钮 overlay + 托盘」不该出现在 macOS 上
  assert.equal(options.autoHideMenuBar, undefined)
  assert.equal(options.titleBarOverlay, undefined, 'macOS 不需要 titleBarOverlay')
  assert.deepEqual(booted.calls.trays, [], 'macOS 有系统菜单栏，不做托盘')
})

test('traffic light padding and drag region are still injected on macOS', () => {
  const { calls, windows } = booted
  windows[0].webContents.emit('did-finish-load')

  const padding = calls.insertedCss.filter((css) => css.includes('padding-top'))
  assert.equal(padding.length, 1, '侧栏顶部必须给红绿灯让位')
  assert.match(padding[0], /padding-top:\s*\d+px/)

  const drag = calls.executedScripts.find((script) => script.includes('dsh-min-drag-region'))
  assert.ok(drag, '必须注入自绘拖拽区（frameless 下窗口本来拖不动）')
  assert.match(drag, /-webkit-app-region/)
  assert.match(drag, /'drag'/)
  // macOS 的几何没有被 Windows 那套改动：仍从 left:80 开始、高 24、点击不穿透
  assert.match(drag, /el\.style\.left = '80px'/)
  assert.match(drag, /innerWidth - 80 - 120/)
  assert.match(drag, /height: '24px'/)
  assert.match(drag, /pointerEvents: 'auto'/)

  // Windows 专属的会话顶栏避让规则不许注入到 macOS
  const windowsOnly = calls.insertedCss.find((css) => css.includes('conversation.session.header'))
  assert.equal(windowsOnly, undefined)
})

test('menu still leads with the macOS application menu', () => {
  const { calls } = booted
  assert.equal(calls.menuTemplate[0].role, 'appMenu')
  const labels = calls.menuTemplate.map((item) => item.label || item.role)
  assert.equal(labels.includes('文件'), false, 'macOS 不该出现 Windows 专属的「文件」菜单')
  for (const label of ['引擎', '通知', '编辑', '视图', '服务']) {
    assert.ok(labels.includes(label), `菜单里应该有「${label}」`)
  }
})

test('closing the window on macOS is left to the system convention', () => {
  // macOS 的系统习惯是「关窗不退出应用」——由系统（Dock / activate）负责再打开，
  // 所以这里**不要**学 Windows 那套拦下来收进托盘（mac 上也没有托盘）。
  let prevented = false
  booted.windows[0].emit('close', { preventDefault: () => { prevented = true } })
  assert.equal(prevented, false)
  assert.equal(booted.calls.hideCount, 0)
  assert.deepEqual(booted.calls.trays, [])
})

test('no Windows AppUserModelID is registered on macOS', () => {
  // AUMID 是 Windows 专属；在 macOS 上设它是多余的，也不该出现
  assert.equal(booted.calls.appUserModelID ?? booted.calls.appUserModelId, undefined)
})

test('engine resolution still offers the version manager shims on POSIX', () => {
  // 版本管理器（volta / nodenv / bun）只暴露 shim，包目录不在标准 node_modules 位置。
  // 这条能力是 macOS 原有的，Windows 化改造里差点被砍掉 —— 这里把它钉住。
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  const block = source.slice(source.indexOf('function standardDshLocations'))
  assert.match(block, /shimLocations\.push\(path\.join\(dir, 'dsh'\)\)/)
  assert.match(block, /\.nodenv/)
  assert.match(block, /\.volta/)

  // PATH / 登录 shell 里的 dsh 兜底必须保留，且限定在 POSIX 上
  assert.match(source, /if \(process\.platform !== 'win32'\) \{\s*const fromPath = findExecutableIn/)
  assert.match(source, /登录 shell 里的 dsh/)
})

test('temporary engine instances keep the SIGTERM-then-SIGKILL ladder', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'updater.js'), 'utf8')
  // 关卡用的冷启动实例：先 SIGTERM 让它排空，7 秒后才升级到 SIGKILL。
  // 这条在 Windows 上被 taskkill 取代，但 POSIX 的语义不能变。
  assert.match(source, /stopTemporary\(child, 'SIGTERM'\)/)
  assert.match(source, /function stopTemporary\(target, signal = 'SIGKILL'\)/)
})
