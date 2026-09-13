'use strict'

/**
 * 用假的 electron 模块把 main.js 完整载入一次的测试辅助。
 *
 * 为什么这么做：main.js 有 2000 行、承载着全部平台分支（窗口形态、红绿灯样式、
 * 菜单结构、AUMID、拖拽区），而真 Electron 需要下载上百 MB 才能开一个窗口。
 * 用一个记录行为的桩就够了，而且**任何平台上都能跑** —— 包括在一台 Windows 机器上
 * 模拟 darwin，验证 macOS 的能力没有被这次兼容改造弄坏。
 *
 * 平台模拟的实现与边界：
 *   `process.platform` 可以在 require 之前改写，所以 platform.js 里那些模块级的
 *   `isWindows` 判断会跟着变。但 `node:path` 的分隔符在**它自己被加载时**就定下来了，
 *   而 node:test 往往已经先加载过它 —— 所以模拟出来的 POSIX 环境里 `path` 可能仍是
 *   win32 语义。断言不要依赖路径字符串的方向性（分隔符、盘符），只依赖**分支选择**。
 */

const fs = require('node:fs')
const Module = require('node:module')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const ROOT = path.join(__dirname, '..', '..')

/** 收集桩上发生的一切，供断言使用。 */
function createElectronStub() {
  const calls = {
    appUserModelId: undefined,
    menuTemplate: undefined,
    menuTemplates: [],
    appMenu: undefined,
    windows: [],
    errorBoxes: [],
    messageBoxes: [],
    quit: false,
    loadedUrls: [],
    loadedFiles: [],
    insertedCss: [],
    executedScripts: [],
    openedExternally: [],
    menuBarVisibility: [],
    titleBarOverlays: [],
    backgroundColors: [],
    nativeThemeHandlers: [],
    hideCount: 0,
    trays: [],
    trayIconPaths: []
  }

  class FakeWebContents {
    constructor(owner) {
      this.owner = owner
      this.handlers = new Map()
      this.windowOpenHandler = undefined
      /** 当前页 URL —— 真实 Electron 里由 loadURL / loadFile 决定，getURL 读它。 */
      this.currentUrl = 'about:blank'
    }

    on(event, handler) {
      const list = this.handlers.get(event) || []
      list.push(handler)
      this.handlers.set(event, list)
    }

    emit(event, ...args) {
      for (const handler of this.handlers.get(event) || []) handler(...args)
    }

    setWindowOpenHandler(handler) {
      this.windowOpenHandler = handler
    }

    insertCSS(css) {
      calls.insertedCss.push(css)
      return Promise.resolve('css-key')
    }

    executeJavaScript(script) {
      calls.executedScripts.push(script)
      return Promise.resolve('ok')
    }

    /**
     * 极其重要：`isSetupPage()` 靠它判断「当前是不是初始化页」。
     * 这里必须给出**真实的 file: URL**（用 pathToFileURL 生成），否则测不出
     * 「URL 路径 vs 文件系统路径」这类只在 Windows 上暴露的比较错误。
     */
    getURL() {
      return this.currentUrl
    }

    loadURL(url) {
      this.currentUrl = url
      calls.loadedUrls.push(url)
      return Promise.resolve()
    }

    loadFile(file) {
      this.currentUrl = pathToFileURL(file).href
      calls.loadedFiles.push(file)
      return Promise.resolve()
    }
  }

  class FakeBrowserWindow {
    constructor(options) {
      this.options = options
      this.handlers = new Map()
      this.webContents = new FakeWebContents(this)
      this.destroyed = false
      calls.windows.push(this)
    }

    on(event, handler) {
      const list = this.handlers.get(event) || []
      list.push(handler)
      this.handlers.set(event, list)
    }

    once(event, handler) {
      this.on(event, handler)
    }

    emit(event, ...args) {
      for (const handler of this.handlers.get(event) || []) handler(...args)
    }

    show() {
      this.shown = true
      this.hidden = false
    }

    hide() {
      this.hidden = true
      calls.hideCount += 1
    }

    isVisible() {
      return !this.hidden
    }

    isDestroyed() {
      return this.destroyed
    }

    isFocused() {
      return true
    }

    isMinimized() {
      return false
    }

    // 窗口上的 loadURL/loadFile 最终落到 webContents —— 真实 Electron 就是这样，
    // 而且 isSetupPage() 读的正是 webContents.getURL()，所以这里必须委托过去。
    loadURL(url) {
      return this.webContents.loadURL(url)
    }

    loadFile(file) {
      return this.webContents.loadFile(file)
    }

    /** 菜单栏显隐 —— Windows 上靠它把菜单栏收起来。 */
    setMenuBarVisibility(visible) {
      calls.menuBarVisibility.push(visible)
    }

    /** Windows 系统按钮的就地样式（透明底板 + 符号色）。 */
    setTitleBarOverlay(options) {
      calls.titleBarOverlays.push(options)
    }

    setBackgroundColor(color) {
      calls.backgroundColors.push(color)
    }
  }

  class FakeTray {
    constructor(icon) {
      this.icon = icon
      this.handlers = new Map()
      calls.trays.push(this)
    }

    setToolTip(text) {
      this.toolTip = text
    }

    setContextMenu(menu) {
      this.contextMenu = menu
    }

    on(event, handler) {
      this.handlers.set(event, handler)
    }

    destroy() {
      this.destroyed = true
    }
  }

  const app = {
    isPackaged: false,
    handlers: new Map(),
    on(event, handler) {
      const list = this.handlers.get(event) || []
      list.push(handler)
      this.handlers.set(event, list)
      return this
    },
    whenReady: () => Promise.resolve(),
    requestSingleInstanceLock: () => true,
    getAppPath: () => ROOT,
    getPath: () => os.tmpdir(),
    setAppUserModelId: (id) => {
      calls.appUserModelId = id
    },
    quit: () => {
      calls.quit = true
    }
  }

  const electron = {
    app,
    BrowserWindow: FakeBrowserWindow,
    Tray: FakeTray,
    // 托盘图标用 nativeImage 读；桩只要能被 resize 并报告"非空"就够
    nativeImage: {
      createFromPath(file) {
        calls.trayIconPaths.push(file)
        return {
          isEmpty: () => false,
          resize: () => ({ isEmpty: () => false, resized: true })
        }
      }
    },
    Menu: {
      buildFromTemplate(template) {
        // 托盘菜单也走这里，所以只记「所有模板」；应用菜单由 setApplicationMenu 认定
        calls.menuTemplates.push(template)
        return { template }
      },
      setApplicationMenu(menu) {
        calls.appMenu = menu
        calls.menuTemplate = menu.template
      }
    },
    dialog: {
      showErrorBox(message, detail) {
        calls.errorBoxes.push({ message, detail })
      },
      showMessageBox(options) {
        calls.messageBoxes.push(options)
        return Promise.resolve({ response: 0 })
      }
    },
    shell: {
      openExternal: (url) => {
        calls.openedExternally.push(url)
        return Promise.resolve()
      }
    },
    nativeTheme: {
      shouldUseDarkColors: false,
      // main.js 会订阅主题变化重设窗口外观；桩必须有 on()，否则启动链会直接抛错
      on(event, handler) {
        calls.nativeThemeHandlers.push({ event, handler })
      }
    },
    Notification: class {
      static isSupported() {
        return true
      }
      on() {}
      show() {}
    },
    session: {
      defaultSession: {
        cookies: {
          get: () => Promise.resolve([]),
          remove: () => Promise.resolve()
        }
      }
    }
  }

  return { electron, calls }
}

/**
 * 轮询等待一个条件成立。
 *
 * 为什么不能用固定 sleep：`npm test`（node --test）会**并行**跑多个测试文件，
 * 机器一忙，固定 500ms 就不够 —— 断言会在「启动链还没走到报错对话框」时失败。
 * 这种 flaky 在单文件跑的时候看不出来，只有走项目自带脚本才会暴露。
 */
async function waitFor(predicate, { timeoutMs = 15_000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/** Windows 上删目录可能撞上刚退出的子进程还握着句柄 —— 重试几次，失败也不致命。 */
async function removeWithRetry(target, attempts = 5) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.rmSync(target, { recursive: true, force: true })
      return true
    } catch {
      // 退避一下再试：子进程退出与目录句柄释放之间有个很短的空窗
      await new Promise((resolve) => setTimeout(resolve, 50 * (i + 1)))
    }
  }
  return false
}

/**
 * 载入 main.js 并跑完它那条异步启动链。
 *
 * 引擎入口指向一个不存在的路径：启动链会一路走到「起不来 → 报错对话框 → 退出」，
 * 这是可以在测试里确定性复现的终点，也不会真的拉起一个后端。
 *
 * @param options.platform 可选：在 require 之前改写 `process.platform`（平台模拟）
 * @param options.overrides 可选：覆盖/移除默认环境变量（值给 undefined 表示**删掉**它）。
 *   例如初始化向导测试要传 `{ DSH_MIN_SKIP_SETUP: undefined }` —— 默认值会跳过向导，
 *   而那正是「带默认值测就永远看不到向导 bug」的原因。
 * @param options.settle 可选：启动链终点的判定条件，默认等「报错对话框 + 退出」
 */
async function bootMain({ platform, overrides = {}, settle } = {}) {
  if (platform && platform !== process.platform) {
    Object.defineProperty(process, 'platform', {
      value: platform,
      configurable: true,
      writable: false
    })
  }

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-main-test-'))
  const previousEnv = {}
  const env = {
    DSH_MIN_HOME: path.join(sandbox, 'home'),
    DSH_MIN_DESKTOP_HOME: path.join(sandbox, 'desktop'),
    DSH_MIN_WORKSPACE: path.join(sandbox, 'workspace'),
    DSH_MIN_SKIP_SETUP: '1',
    DSH_MIN_NO_UPDATE_CHECK: '1',
    DSH_MIN_NO_NOTIFY: '1',
    DSH_MIN_PORT: '0',
    DSH_MIN_BIN: path.join(sandbox, 'missing-engine', 'lib', 'bin.js'),
    ...overrides
  }
  for (const [key, value] of Object.entries(env)) {
    previousEnv[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }

  const { electron, calls } = createElectronStub()
  const originalLoad = Module._load
  Module._load = function patchedLoad(request, ...rest) {
    if (request === 'electron') return electron
    return originalLoad.call(this, request, ...rest)
  }

  const mainPath = require.resolve('../../main')
  delete require.cache[mainPath]
  require(mainPath)

  // 等启动链真的走到终点（默认：引擎起不来 → 报错对话框 + quit），而不是盲等固定时长。
  // 注意 settle 回调**只能**用传进来的 calls，不能引用 bootMain 的返回值 ——
  // 那个赋值要等这里返回之后才发生（踩过这个坑：断言里引用 booted 会导致永远等不到）。
  const settled = await waitFor(() =>
    settle ? settle(calls) : calls.errorBoxes.length > 0 && calls.quit === true
  )

  const cleanup = async () => {
    Module._load = originalLoad
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await removeWithRetry(sandbox)
  }

  return { calls, windows: calls.windows, cleanup, settled, ROOT }
}

module.exports = { bootMain, createElectronStub, waitFor, ROOT }
