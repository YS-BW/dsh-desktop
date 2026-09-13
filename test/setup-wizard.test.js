'use strict'

/**
 * **首次启动向导**（选装插件页）的回归测试。
 *
 * 为什么单独一个文件：默认的 bootMain 会带 `DSH_MIN_SKIP_SETUP=1`（为了测后面的启动链），
 * 于是**向导这条路径在所有既有测试里都被跳过**。实测后果就是：Windows 上一个
 * `isSetupPage()` 的路径比较错误同时造成「插件列表空白」和「跳过/继续按钮全都点不动」，
 * 用户直接卡在向导里 —— 而整套测试全绿。
 *
 * 所以这里必须显式把 SKIP_SETUP 去掉，专门覆盖这个页面。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { after, before } = require('node:test')

const { bootMain } = require('./helpers/electron-stub')

let booted
before(async () => {
  booted = await bootMain({
    // 关键：不跳过向导（默认值会跳过，那正是漏测的根源）
    overrides: { DSH_MIN_SKIP_SETUP: undefined },
    // 向导页会停在这里等用户操作，不会自己走到「报错 + 退出」——
    // 所以终点条件是「向导页加载完成并推了状态」
    settle: (calls) => calls.executedScripts.some((script) => script.includes('__dshSetup'))
  })
})
after(() => booted?.cleanup())

test('first run lands on the setup page, not the splash', () => {
  assert.equal(booted.settled, true, '向导页应该在超时前完成加载并收到状态')
  const loaded = booted.calls.loadedFiles.map((f) => path.basename(f))
  assert.ok(loaded.includes('setup.html'), `应该加载了初始化页，实际加载过：${loaded.join(', ')}`)
  // 还没到启动后端那一步，所以不该有报错对话框
  assert.deepEqual(booted.calls.errorBoxes, [])
})

test('the plugin catalog actually reaches the page (the empty-list bug)', () => {
  const push = booted.calls.executedScripts.find((s) => s.includes('__dshSetup'))
  assert.ok(push, '必须把插件清单推给初始化页（否则页面空白，什么都选不了）')

  // 推过去的 payload 里必须有白名单里的两个插件
  assert.match(push, /dsh-market/)
  assert.match(push, /dsh-better-sidebar/)
  // 而且是真的走 __dshSetup.update，而不是别的东西
  assert.match(push, /window\.__dshSetup && window\.__dshSetup\.update\(/)
})

test('the setup page is recognised as the setup page on this platform', async () => {
  // 这条是这次真 bug 的核心：isSetupPage() 一旦返回 false，
  // 状态推不进去 + 意图处理直接早退 = 空列表 + 按钮失效。
  // 这里通过「推状态是否发生」间接断言它，同时也直接验证 URL 形态。
  const contents = booted.windows[0].webContents
  assert.match(contents.getURL(), /^file:\/\//)
  // 打包后路径含空格，URL 里是 %20 —— fileURLToPath 要能还原回来
  assert.equal(path.basename(new URL(contents.getURL()).pathname).endsWith('setup.html'), true)
  assert.ok(contents.getURL().includes('setup.html'))
})

test('the skip intent is handled instead of dying silently', async () => {
  const { calls, windows } = booted

  // 「跳过」按钮在页面里是 `window.location.href = 'dsh-setup://continue?plugins='`
  let prevented = false
  windows[0].webContents.emit(
    'will-navigate',
    { preventDefault: () => { prevented = true } },
    'dsh-setup://continue?plugins='
  )
  assert.equal(prevented, true, '自定义意图必须被拦下，交给主进程处理')

  // 被接住的证据：主进程继续走了「启动后端」这条路 ——
  // 窗口切到接管页，随后因为我们的引擎路径是假的而报错退出。
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline && calls.errorBoxes.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  const loaded = calls.loadedFiles.map((f) => path.basename(f))
  assert.ok(loaded.includes('splash.html'), `意图被处理后应先切到接管页，实际：${loaded.join(', ')}`)
  assert.equal(calls.errorBoxes.length, 1)
  assert.equal(calls.errorBoxes[0].message, '启动 dsh 失败')
})

test('a failed setup does not mark the wizard as completed', () => {
  // 引擎起不来时不写完成标记，所以下次启动还会回到向导 —— 用户不会被卡在一个坏状态里
  const settings = path.join(process.env.DSH_MIN_DESKTOP_HOME, 'settings.json')
  if (fs.existsSync(settings)) {
    const parsed = JSON.parse(fs.readFileSync(settings, 'utf8'))
    assert.equal(parsed.setupReceipt, undefined, '启动失败时不该写完成标记')
  }
})
