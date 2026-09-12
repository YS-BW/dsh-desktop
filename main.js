'use strict'

/**
 * dsh-desktop-min — 把官方 DSH Web UI 装进一个原生 macOS 窗口。
 *
 * 这个壳对 dsh 的唯一依赖是三个公开约定，一行都不改 dsh 的源码：
 *   1. 命令行:   dsh web --no-open --host 127.0.0.1 --port <n>
 *   2. 环境变量: DSH_HOME（数据目录）、cwd（工作目录，决定会话分区）
 *   3. stdout:  启动时打印一行 `dsh web: <带 token 的 URL>`
 *
 * 之所以能用「真 Node 二进制」而不是 Electron 内置 Node：内置 Node 跑在
 * utility process 里时 `--expose-internals` 进不了 Node 的选项解析器，
 * 导致 Cordis 的 HMR 服务构造失败、整个 profile 启动挂掉，社区版为此写了
 * 一个 hmr-fallback 插件。真 Node 没有这个问题，所以这里零插件。
 */

const { app, BrowserWindow, shell, dialog, Menu, nativeTheme } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// ── 可覆盖的配置（都有默认值，不设就是「跟官方共用」）─────────────────────

/** DSH 数据目录。默认 ~/.dsh，与命令行 dsh 完全共用，所以会话/配置/凭据互通。 */
const DSH_HOME = process.env.DSH_MIN_HOME
  ? path.resolve(process.env.DSH_MIN_HOME)
  : path.join(os.homedir(), '.dsh')

/**
 * 默认工作目录。
 *
 * 为什么不能默认 `process.cwd()`：实测 `npm start` 时壳的 cwd 是「这个壳项目自己的
 * 目录」，而 DSH 按 cwd 给会话分桶 —— 那会让桌面端建一个全新的空桶，网页端的历史
 * 会话（在别的目录下）一条都看不到。打包成 .app 双击启动时 cwd 更是指向别处。
 * 所以这里必须显式给出一个真实项目目录。
 *
 * 改这里，或者用 DSH_MIN_WORKSPACE 环境变量覆盖。
 */
const DEFAULT_WORKSPACE = '/Users/lixinlv/Documents/DSH'

/**
 * 工作目录。DSH 按进程 cwd 给会话分桶（$DSH_HOME/sessions/<编码后的cwd>/），
 * 要和网页端看到同一批会话，这个路径必须和你在网页端启动 dsh 时的目录一致。
 */
const WORKSPACE = path.resolve(process.env.DSH_MIN_WORKSPACE || DEFAULT_WORKSPACE)

/** dsh 可执行文件：优先环境变量，其次 PATH，最后常见安装位置。 */
function resolveDshBin() {
  if (process.env.DSH_MIN_BIN) return process.env.DSH_MIN_BIN
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, 'dsh')
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {}
  }
  const fallback = path.join(
    os.homedir(),
    '.hermes/node/lib/node_modules/@deepseek-ai/dsh/lib/bin.js'
  )
  return fs.existsSync(fallback) ? fallback : undefined
}

// ── 运行状态 ────────────────────────────────────────────────────────────

let child
let win
let baseUrl
/** 本次启动是否由我们拉起了后端（决定退出时要不要收尸）。 */
let ownsChild = false
let quitting = false

const log = (...args) => console.log('[dsh-min]', ...args)

// ── 孤儿后端清理 ────────────────────────────────────────────────────────

/**
 * 看门狗：一个独立的小进程，盯着这个壳；壳一死就替我们把后端收干净。
 *
 * 为什么需要：壳可能被 `kill -9`、崩溃、或被系统强制结束 —— 那时任何信号处理器
 * 都不会运行。实测确实会留下占着端口继续跑的孤儿 `dsh web`。看门狗不依赖 IPC、
 * 只轮询壳是否还活着，所以能覆盖壳自己来不及处理的情况。
 */
function startWatchdog(backendPid) {
  try {
    const watcher = spawn(
      process.execPath,
      [path.join(__dirname, 'watchdog.js'), String(process.pid), String(backendPid)],
      // detached + unref：让看门狗独立于壳的进程组，壳被整组杀掉时它也能活下来。
      { detached: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
    )
    watcher.unref()
    log(`看门狗已启动 (backend pid=${backendPid})`)
  } catch (error) {
    log('看门狗启动失败:', String(error.message || error))
  }
}

/**
 * 从子进程输出里抓启动 URL。
 *
 * dsh-web-app 会打印 `dsh web: http://127.0.0.1:PORT/?token=...`，那个 token
 * 是进程级随机、且只接受 `GET /?token=` 一种兑换方式（API 路径和 Authorization
 * 头都不认）。所以只能从 stdout 拿 —— 这是官方提供的唯一入口。
 */
function extractAuthenticatedUrl(text) {
  const match = text.match(/dsh web:\s*(http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/)
  return match ? match[1] : undefined
}

/** 剥掉 ANSI 转义，避免颜色码把 URL 切碎。 */
const stripAnsi = (s) => s.replace(/\u001B\[[0-9;]*m/g, '')

function startBackend(port) {
  const bin = resolveDshBin()
  if (!bin) {
    dialog.showErrorBox(
      '找不到 dsh',
      '请先安装 DeepSeek Harness，或用 DSH_MIN_BIN 指定 dsh 的路径。'
    )
    app.quit()
    return
  }

  fs.mkdirSync(WORKSPACE, { recursive: true })

  const args = [
    'web',
    '--no-open', // 窗口就是唯一的界面，不要再弹浏览器
    '--host',
    '127.0.0.1',
    '--port',
    String(port)
  ]

  log('启动后端:', bin, args.join(' '))
  log('  DSH_HOME =', DSH_HOME)
  log('  cwd      =', WORKSPACE)

  child = spawn(bin, args, {
    cwd: WORKSPACE,
    env: { ...process.env, DSH_HOME, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  const onChunk = (buf) => {
    const text = stripAnsi(buf.toString())
    process.stdout.write(text)
    if (!baseUrl) {
      const url = extractAuthenticatedUrl(text)
      if (url) {
        baseUrl = url
        ownsChild = true
        log('后端就绪:', url.replace(/token=.*/, 'token=<hidden>'))
        loadIntoWindow(url)
      }
    }
  }

  child.stdout.on('data', onChunk)
  child.stderr.on('data', onChunk)

  child.on('error', (error) => {
    dialog.showErrorBox('启动 dsh 失败', String(error.message || error))
    app.quit()
  })

  // 后端起得来才需要看门狗；spawn 失败时没有子进程可看。
  if (child.pid !== undefined) startWatchdog(child.pid)

  child.on('exit', (code, signal) => {
    log('后端退出:', { code, signal })
    child = undefined
    if (!quitting) {
      // 后端没了，窗口留着也没意义；正常退出路径由 before-quit 处理。
      dialog.showErrorBox(
        '后端已退出',
        `dsh 进程结束了（code=${code} signal=${signal}）。请重新启动应用。`
      )
      app.quit()
    }
  })
}

/**
 * 把一个已经跑起来的 dsh 实例（例如你终端里的那个）接进窗口。
 * 仅在 DSH_MIN_ATTACH 指向一个带 token 的 URL 时使用。
 */
function attachToExisting(url) {
  baseUrl = url
  ownsChild = false
  log('接入已有后端:', url.replace(/token=.*/, 'token=<hidden>'))
  loadIntoWindow(url)
}

function loadIntoWindow(url) {
  if (win && !win.isDestroyed()) {
    win.loadURL(url)
    win.show()
  }
}

// ── 窗口 ────────────────────────────────────────────────────────────────

/**
 * macOS 红绿灯的顶部留白 —— 用 Electron 的 insertCSS 注入，**不改 dsh 一个字节**。
 *
 * 为什么需要：`titleBarStyle: 'hidden'` 把窗口内容延伸到顶部，红绿灯浮在内容之上。
 * 实测 dsh 侧栏从窗口左上角 (0,0) 开始、logo 行只有 6px 上边距，所以品牌标落在
 * (16, 27)，而系统红绿灯大约占 x≈10~72 / y≈10~24 —— 直接压在按钮下面。
 *
 * 为什么不用 dsh 的类名做选择器：它的 CSS 类是构建期哈希的，且**不同构建产物哈希
 * 不同**（官方 npm 构建是 `hHd-Xa_root`，作者本地构建是 `IrIWsq_root`，版本号相同）。
 * 任何依赖类名的样式都会随升级失效，所以这里用结构选择器：
 *   #root > div           → 布局框架
 *   :first-child          → 侧栏列
 *   :first-child          → 侧栏根
 * 只要 dsh 保持「侧栏是框架的第一列」，这条规则就永远有效。
 */
const TRAFFIC_LIGHT_PAD_TOP = process.env.DSH_MIN_TOP_PAD || '30'

const TRAFFIC_LIGHT_CSS = `
  /* ── 1. 给红绿灯让出顶部空间 ─────────────────────────────────
     dsh 侧栏从窗口左上角 (0,0) 开始、logo 行只有 6px 上边距，品牌标落在 (16,27)，
     而系统红绿灯约占 x≈10~72 / y≈10~24 —— 直接压住。往下推一点。 */
  #root > div > div:first-child > div:first-child {
    padding-top: ${TRAFFIC_LIGHT_PAD_TOP}px !important;
  }

`

/**
 * 注入一条透明拖拽条，恢复原生窗口拖拽手势。
 *
 * 为什么需要：frameless + titleBarStyle:'hidden' 下 Chromium 不会给内容区自动拖拽能力
 * —— 实测裸窗口里所有元素的 -webkit-app-region 都是 none，dsh 自己也不设置，所以窗口
 * 完全拖不动。而 dsh 的 UI 铺满窗口，没有现成的空白标题栏可用。
 *
 * 做法（照搬社区版 DSH Desktop 验证过的模式）：用 executeJavaScript 在页面里建一个
 * 透明 div，设 -webkit-app-region: drag，贴在最顶部。
 *   · top 0 / height 24   → 正好落在红绿灯那一行的纵向范围内，不压到任何内容
 *   · left 80             → 避开 macOS 红绿灯（它们横向约占 10~72）
 *   · right 按窗口宽度算   → 避开右侧的头部按钮；窄窗口时自动收窄，不留 0 宽元素
 *   · z-index 18          → 浮在内容之上
 *
 * 只提供「抓取」区域，本身完全透明，不影响任何观感。
 */
function installDragRegion(target) {
  if (process.platform !== 'darwin') return
  target.webContents
    .executeJavaScript(
      `(() => {
        const ID = 'dsh-min-drag-region'
        const place = () => {
          let el = document.getElementById(ID)
          if (!el) {
            el = document.createElement('div')
            el.id = ID
            el.setAttribute('aria-hidden', 'true')
            Object.assign(el.style, {
              position: 'fixed',
              top: '0',
              height: '24px',
              background: 'transparent',
              pointerEvents: 'auto',
              userSelect: 'none'
            })
            el.style.setProperty('-webkit-app-region', 'drag')
            document.body.appendChild(el)
          }
          // 右侧至少留出 120px 给头部按钮；窗口太窄就整体不启用。
          const reserved = 120
          const left = 80
          const width = window.innerWidth - left - reserved
          el.style.left = left + 'px'
          el.style.right = 'auto'
          el.style.width = Math.max(0, width) + 'px'
          el.style.display = width > 40 ? 'block' : 'none'
        }
        place()
        window.addEventListener('resize', place)
        return 'ok'
      })()`
    )
    .catch(() => {})
}

function createWindow() {
  const isMac = process.platform === 'darwin'

  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 520,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#171513' : '#ffffff',
    // macOS：隐藏标题栏但保留红绿灯，窗口内容延伸到顶部。
    // 这就是「自然融入」的来源；Windows/Linux 保持普通边框。
    frame: !isMac,
    ...(isMac ? { titleBarStyle: 'hidden' } : {}),
    webPreferences: {
      // 加载的是远端(loopback)页面，必须保持隔离，不给 Node 能力。
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  })

  win.once('ready-to-show', () => win.show())

  // 外链交给系统浏览器，窗口内不开新窗口。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1:')) return { action: 'allow' }
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 只允许留在本机 loopback 上，防止被导航到外部站点。
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('http://127.0.0.1:')) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })

  // 等 DOM 就绪后再注入，避免样式被后续渲染覆盖。
  win.webContents.on('did-finish-load', () => {
    win.webContents.insertCSS(TRAFFIC_LIGHT_CSS).catch(() => {})
    installDragRegion(win)
  })

  win.on('closed', () => {
    win = undefined
  })

  return win
}


function buildMenu() {
  const isMac = process.platform === 'darwin'
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'toggleDevTools' }
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ── 生命周期 ────────────────────────────────────────────────────────────

app.on('window-all-closed', () => {
  // macOS 习惯：关窗不退出应用，后端继续跑，任务不中断。
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (win) {
    win.show()
    return
  }
  createWindow()
  if (baseUrl) loadIntoWindow(baseUrl)
})

app.on('before-quit', (event) => {
  if (quitting) return
  quitting = true
  if (!ownsChild || !child || child.exitCode !== null) return

  event.preventDefault()
  log('关闭后端（SIGTERM）…')
  // DSH 自己给了 5 秒排空应用的宽限期（PROCESS_SHUTDOWN_TIMEOUT_MS = 5e3），
  // 宽限设 7 秒再强杀，免得把它排空到一半砍掉、留下半截会话日志。
  // 注意：这条路径只负责「优雅」；如果壳被强杀、这里根本没机会跑，
  // 由 watchdog.js 兜底收尸。
  const force = setTimeout(() => {
    if (child && child.exitCode === null) child.kill('SIGKILL')
    app.quit()
  }, 7000)
  child.once('exit', () => {
    clearTimeout(force)
    app.quit()
  })
  child.kill('SIGTERM')
})

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    buildMenu()
    createWindow()

    // DSH_MIN_ATTACH：接入一个已经在跑的实例（跳过自己拉起后端）。
    // 那个实例的 token 只存在于它自己的启动输出里，所以必须由你显式提供。
    if (process.env.DSH_MIN_ATTACH) {
      attachToExisting(process.env.DSH_MIN_ATTACH)
      return
    }

    // port 0 = 让系统分配空闲端口，避免和你在终端里跑的 dsh 抢端口。
    // 孤儿后端由 watchdog.js 负责（壳一死就收尸），这里不用管。
    startBackend(0)
  })
}
