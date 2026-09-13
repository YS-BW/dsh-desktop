'use strict'

/**
 * 用假的 electron 模块把 main.js 完整载入一次（当前真实平台）。
 *
 * 为什么这么做：main.js 有 2000 行、零测试覆盖，而它承载的恰恰是**平台分支**
 * （窗口形态、红绿灯样式、菜单结构、AUMID）。真 Electron 需要下载上百 MB 才能
 * 开一个窗口，而这里要验证的只是「载入路径 + 平台分支 + 启动链不炸」——
 * 用一个记录行为的桩就够了，而且在任何平台上都能跑。
 *
 * macOS 那一侧的分支由 macos-compat.test.js 在模拟 darwin 下覆盖。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const test = require('node:test')
const { after, before } = require('node:test')

const { bootMain } = require('./helpers/electron-stub')

const isWindows = process.platform === 'win32'

// 整个文件只走一次启动链：main.js 是单例式的（模块级状态 + 单实例锁），
// 每个用例各载一次会重复 spawn 后端和看门狗，既慢又吵。
let booted
before(async () => {
  booted = await bootMain()
})
after(() => booted?.cleanup())

test('main.js boots on this platform without throwing', () => {
  const { calls, windows, settled } = booted

  assert.equal(settled, true, '启动链应该在超时前走到「报错对话框 + 退出」')
  assert.equal(windows.length, 1, '应该恰好创建了一个窗口')
  assert.ok(calls.menuTemplate, '应该构建了应用菜单')
  assert.ok(calls.appMenu, '应该设置了应用菜单')

  // 找不到引擎时必须是「报一个对话框然后退出」，而不是崩掉或者卡住
  assert.equal(calls.errorBoxes.length, 1)
  assert.equal(calls.errorBoxes[0].message, '启动 dsh 失败')
  assert.equal(calls.quit, true)
})

test('window shape follows the platform', () => {
  const options = booted.windows[0].options
  // 两个平台都把系统标题栏去掉，让内容延伸到窗口最上面（「融入」的前提）
  assert.equal(options.titleBarStyle, 'hidden')
  if (isWindows) {
    assert.equal(options.frame, true)
    // 菜单栏默认收起（Alt 唤出），不常驻占一条
    assert.equal(options.autoHideMenuBar, true)
    // 三个窗口按钮浮在内容右上角，**底板全透明** —— 这是没有系统灰底横条的关键
    assert.ok(options.titleBarOverlay, 'Windows 必须有 titleBarOverlay')
    assert.equal(options.titleBarOverlay.color, '#00000000')
    assert.equal(typeof options.titleBarOverlay.symbolColor, 'string')
    assert.equal(options.titleBarOverlay.height, 36)
  } else {
    assert.equal(options.frame, false)
    // macOS 不需要 overlay：红绿灯本来就浮在内容上
    assert.equal(options.titleBarOverlay, undefined)
  }
  // 远端页面永远不给 Node 能力
  assert.equal(options.webPreferences.nodeIntegration, false)
  assert.equal(options.webPreferences.contextIsolation, true)
  assert.equal(options.webPreferences.sandbox, true)
})

test('the menu bar is hidden and the tray keeps the actions reachable', () => {
  const { calls } = booted

  if (!isWindows) {
    // macOS 走系统菜单栏，不该有托盘
    assert.deepEqual(calls.trays, [])
    return
  }

  // 菜单栏收起只靠窗口选项 autoHideMenuBar（上面那条断言）。
  //
  // **不要**再调 setMenuBarVisibility：实测它与 autoHideMenuBar 同时用时，
  // titleBarOverlay 的窗口按钮会整个消失（窗口没有关闭按钮）—— 这条断言就是防回归的。
  assert.deepEqual(
    calls.menuBarVisibility,
    [],
    '不许调 setMenuBarVisibility：它会让系统窗口按钮消失（见 main.js 里的实测注释）'
  )

  // 托盘存在，并且放了「功能仍可达」的入口
  assert.equal(calls.trays.length, 1, 'Windows 上应该创建托盘')
  const tray = calls.trays[0]
  const labels = (tray.contextMenu?.template || []).map((item) => item.label).filter(Boolean)
  for (const label of ['显示窗口', '检查更新…', '测试通知权限…', '退出']) {
    assert.ok(labels.includes(label), `托盘菜单里应该有「${label}」：实际 ${labels.join('、')}`)
  }
  // 托盘图标必须指向包内真实存在的文件（打包时漏了它托盘就是空白图标）
  const iconPath = calls.trayIconPaths[0]
  assert.ok(iconPath, '应该用 nativeImage 读托盘图标')
  assert.ok(fs.existsSync(iconPath), `托盘图标文件不存在：${iconPath}`)
  assert.equal(tray.toolTip, 'DSH Desktop Min')
})

test('macOS-only traffic light padding is not injected on Windows', () => {
  const { calls, windows } = booted
  // 触发 did-finish-load —— 红绿灯留白就挂在这个事件上
  windows[0].webContents.emit('did-finish-load')

  const paddingCss = calls.insertedCss.filter((css) => css.includes('padding-top'))
  const dragScript = calls.executedScripts.find((s) => s.includes('dsh-min-drag-region'))
  // 两个平台都需要自绘拖拽条（系统标题栏都没了）
  assert.ok(dragScript, '必须注入拖拽条，否则窗口拖不动')

  if (isWindows) {
    assert.deepEqual(paddingCss, [], 'Windows 上没有红绿灯，不该注入顶部留白')
    // Windows 的拖拽条横跨整条顶栏，必须让点击穿透（dsh 侧栏品牌标就在这条带子里）
    assert.match(dragScript, /pointerEvents: 'none'/)
    assert.match(dragScript, /height: '36px'/)
    // 让开系统按钮，宽度用 env(titlebar-area-*) 现算（全屏时会自动变 0）
    assert.match(dragScript, /env\(titlebar-area-width/)
    // 会话顶栏右侧避让 + 交互元素排除拖拽
    const chrome = calls.insertedCss.find((css) => css.includes('conversation.session.header'))
    assert.ok(chrome, 'Windows 必须给会话顶栏注入右侧避让规则')
    assert.match(chrome, /data-slot="conversation\.session\.header"/)
    assert.match(chrome, /padding-right: calc\(/)
    assert.match(chrome, /-webkit-app-region: no-drag/)
  } else {
    assert.equal(paddingCss.length, 1, 'macOS 上必须注入红绿灯留白')
    assert.match(dragScript, /pointerEvents: 'auto'/)
    assert.match(dragScript, /height: '24px'/)
    assert.match(dragScript, /el\.style\.left = '80px'/)
    const chrome = calls.insertedCss.find((css) => css.includes('conversation.session.header'))
    assert.equal(chrome, undefined, 'Windows 专属规则不该出现在 macOS 上')
  }
})

test('closing the window goes to the tray on Windows instead of quitting', () => {
  const { calls, windows } = booted
  const window = windows[0]

  let prevented = false
  window.emit('close', { preventDefault: () => { prevented = true } })

  if (isWindows) {
    // 关窗只是收进托盘：后端与长任务必须活着，退出只走托盘菜单（或 app.quit()）
    assert.equal(prevented, true, 'Windows 上关窗应被拦下（收进托盘），而不是退出应用')
    assert.equal(calls.hideCount, 1, '应该把窗口隐藏起来')
    assert.equal(window.isVisible(), false)
  } else {
    // macOS 的系统习惯是关窗不退出应用，由系统（Dock / activate）负责再打开 —— 不要额外拦
    assert.equal(prevented, false, 'macOS 不该拦关窗')
  }
})

test('the tray offers a way back and a way out', () => {
  if (!isWindows) {
    assert.deepEqual(booted.calls.trays, [])
    return
  }
  const tray = booted.calls.trays[0]
  assert.ok(tray.handlers.has('click'), '左键点托盘图标应该能唤回窗口')
  const labels = (tray.contextMenu?.template || []).map((item) => item.label).filter(Boolean)
  assert.ok(labels.includes('退出'), '托盘菜单必须能完全退出（否则用户没有别的出口）')
})

test('menu template matches the platform convention', () => {
  const { calls } = booted
  const labels = calls.menuTemplate.map((item) => item.label || item.role)

  if (isWindows) {
    // Windows 没有系统应用菜单，必须有能点的「退出」，否则菜单里没有退出入口
    assert.equal(calls.menuTemplate[0].label, '文件')
    const quit = calls.menuTemplate[0].submenu.find((item) => item.role === 'quit')
    assert.ok(quit, 'Windows 菜单里必须有退出一项')
    assert.equal(labels.includes('appMenu'), false)
  } else {
    assert.equal(calls.menuTemplate[0].role, 'appMenu')
  }

  // 两个平台共有的分块
  for (const label of ['引擎', '通知', '编辑', '视图', '服务']) {
    assert.ok(labels.includes(label), `菜单里应该有「${label}」`)
  }
})

test('Windows registers an AppUserModelID for toast notifications', () => {
  const { calls } = booted
  if (isWindows) {
    // 少了它，通知会被系统静默丢弃（isSupported() 仍然返回 true）
    assert.equal(calls.appUserModelId, 'com.dsh.desktopmin')
  } else {
    assert.equal(calls.appUserModelId, undefined)
  }
})

test('remote navigation stays on loopback and setup intents stay gated', () => {
  const contents = booted.windows[0].webContents

  // 外链交给系统浏览器，窗口内不开新窗口、也不放行非回环地址
  assert.deepEqual(contents.windowOpenHandler({ url: 'https://example.com/' }), { action: 'deny' })
  assert.deepEqual(contents.windowOpenHandler({ url: 'http://127.0.0.1:43140/' }), {
    action: 'allow'
  })
  // 自定义意图不能直接被放行（它必须经过 isSetupPage 校验）
  assert.deepEqual(contents.windowOpenHandler({ url: 'dsh-setup://install?id=dsh-market' }), {
    action: 'deny'
  })

  // 导航到外部站点必须被拦下
  let prevented = false
  contents.emit(
    'will-navigate',
    { preventDefault: () => { prevented = true } },
    'https://example.com/'
  )
  assert.equal(prevented, true)
  // 外链一律交给系统浏览器，回环地址绝不外开
  assert.ok(booted.calls.openedExternally.length >= 1)
  assert.ok(booted.calls.openedExternally.every((url) => url === 'https://example.com/'))
})
