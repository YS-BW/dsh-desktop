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

const { app, BrowserWindow, shell, dialog, Menu, nativeTheme, Notification } = require('electron')
const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const { createUpdater } = require('./updater')
const { createTurnWatcher, formatDuration, summarize } = require('./notify')

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

/**
 * 这个桌面端自己的数据根目录（**不是** DSH 的 home）。
 * 目前只放「从 npm 更新下来的引擎」，所以它必须可写、且在 App 包外面。
 */
const DESKTOP_HOME = process.env.DSH_MIN_DESKTOP_HOME
  ? path.resolve(process.env.DSH_MIN_DESKTOP_HOME)
  : path.join(os.homedir(), '.dsh-desktop')

/**
 * 解析后端引擎：返回 { node, bin, source } 或 undefined。
 *
 * 引擎策略：**自带一份 + 菜单栏从 npm 升级**。
 *
 *   1. 已升级的引擎（优先）—— `~/.dsh-desktop/engines/<版本>/`，由 `updater.js` 从 npm 拉，
 *      `current` 指针文件记住当前用哪个。它在 App 外面，所以升级引擎**不用重新打包、
 *      不用重新下载 App**。装在版本化目录里，升级时正在跑的那份全程不动。
 *   2. 自带的一份 —— 打进 App 里，下载 DMG 的人**双击就能用**，无需预装任何东西。
 *   3. DSH_MIN_BIN —— 显式覆盖，调试用。
 *   4. 系统 dsh（PATH / 标准位置 / 登录 shell）—— 开发态与兜底。
 *
 * 为什么每条自带/更新路径都要连 node 一起带：dsh 的 shebang 是
 * `#!/usr/bin/env node`，靠 PATH 找一个 node。下载 App 的人 PATH 里未必有 node
 * （从 Finder 启动时更是只有 launchd 的最小 PATH），所以必须用自带的 node 加载
 * bin.js，而不是把 bin.js 当可执行文件去 spawn。
 *
 * 为什么必须是「真 Node」而不能借 Electron 内置的那个：dsh 的 web profile 默认
 * `patchReload: "live"`，会建 Cordis HMR 服务，而它需要 Node 内部模块加载器
 * （--expose-internals）。Electron 跑在 utility process 里时这个标志进不了 Node 的
 * 选项解析器，HMR 构造失败会带崩整个 profile 启动 —— 社区版为此专门写了一个
 * hmr-fallback 插件。真 Node 没这个问题，所以这里一个插件都不用。
 */
function resolveEngine() {
  if (process.env.DSH_MIN_BIN) {
    return { node: undefined, bin: process.env.DSH_MIN_BIN, source: 'DSH_MIN_BIN' }
  }

  // 1. `current` 指针指向的已升级引擎（engines/<版本>/）
  //
  // 版本化目录是关键：升级时新版本装到 engines/<新版本>/，正在跑的那份全程不动。
  // dsh 运行时会用 `await import()` 延迟加载模块（装插件、profile 热重载都会触发），
  // 如果升级去动它脚下的文件，那些 import 会失败或加载到新旧混合的状态。
  const engine = updater()
  const version = engine?.currentVersion()
  if (version) {
    const bin = engine.engineBinPath(engine.engineDir(version))
    const node = bundledNodePath()
    if (node && fs.existsSync(bin)) {
      return { node, bin, source: `已升级引擎 ${version}` }
    }
  }

  // 2. 自带引擎
  const bundledBin = bundledDshEntry()
  const bundledNode = bundledNodePath()
  if (bundledBin && bundledNode) {
    return { node: bundledNode, bin: bundledBin, source: `自带引擎 ${engineVersion(bundledBin)}` }
  }

  // 3-4. 开发态 / 兜底：系统里的 dsh
  for (const location of standardDshLocations()) {
    if (isExecutable(location)) return { node: undefined, bin: location, source: '系统 dsh' }
  }
  const fromPath = findExecutableIn(process.env.PATH || '', 'dsh')
  if (fromPath) return { node: undefined, bin: fromPath, source: 'PATH 上的 dsh' }
  const fromShell = findExecutableIn(loginShellPath() || '', 'dsh')
  if (fromShell) return { node: undefined, bin: fromShell, source: '登录 shell 里的 dsh' }

  return undefined
}

/** 读引擎版本号，只用于日志。读不到就返回「未知版本」。 */
function engineVersion(binPath) {
  try {
    const manifest = path.join(path.dirname(binPath), '..', 'package.json')
    return JSON.parse(fs.readFileSync(manifest, 'utf8')).version || '未知版本'
  } catch {
    return '未知版本'
  }
}

/** 自带的 Node 运行时（随 App 打包）。 */
function bundledNodePath() {
  const name = process.platform === 'win32' ? 'node.exe' : 'node'
  try {
    const require = createRequire(path.join(app.getAppPath(), 'package.json'))
    const node = path.join(path.dirname(require.resolve('node/package.json')), 'bin', name)
    return fs.existsSync(node) ? node : undefined
  } catch {
    return undefined
  }
}

/**
 * 打进 App 的 dsh 入口。
 *
 * 版本号不写死：用 createRequire 从 node_modules 里解析，升级自带版本时不用改代码。
 */
function bundledDshEntry() {
  try {
    const base = app.isPackaged
      ? path.join(app.getAppPath(), 'package.json')
      : __filename
    const require = createRequire(base)
    return require.resolve('@deepseek-ai/dsh/lib/bin.js')
  } catch {
    return undefined
  }
}

/**
 * npm 全局安装 dsh 后，可执行文件最可能出现的位置。
 *
 * npm 的全局 bin 目录随 prefix 变化，常见形态有：
 *   /usr/local/bin、/opt/homebrew/bin      —— Homebrew 的 node
 *   ~/.npm-global/bin、~/.local/bin        —— 常见的用户级 prefix
 *   ~/.nvm/versions/node/<版本>/bin        —— nvm
 *   ~/.volta/bin                           —— volta
 * 另外也直接找包目录，跳过可能缺失的 shim。
 */
function standardDshLocations() {
  const home = os.homedir()
  const binDirs = [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.local', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.nodenv', 'shims')
  ]

  // nvm：每个已安装版本一个 bin 目录
  try {
    const nvmVersions = path.join(home, '.nvm', 'versions', 'node')
    for (const version of fs.readdirSync(nvmVersions)) {
      binDirs.push(path.join(nvmVersions, version, 'bin'))
    }
  } catch {}

  const locations = []
  for (const dir of binDirs) locations.push(path.join(dir, 'dsh'))

  // 直接指向包入口，跳过 shim
  const moduleRoots = [
    '/usr/local/lib/node_modules',
    '/opt/homebrew/lib/node_modules',
    path.join(home, '.npm-global', 'lib', 'node_modules'),
    path.join(home, '.local', 'lib', 'node_modules')
  ]
  for (const root of moduleRoots) {
    locations.push(path.join(root, '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  }

  return locations
}

/**
 * 子进程要用的环境变量。
 *
 * 找到 dsh 还不够：它的 shebang 是 `#!/usr/bin/env node`，需要 PATH 里有 node。
 * 从 Finder/启动台启动时，应用只有 launchd 的最小 PATH（/usr/bin:/bin:/usr/sbin:/sbin），
 * 里面没有 node，dsh 会直接以 127（command not found）退出。
 *
 * 所以这里在必要时把登录 shell 的 PATH 并进来 —— 仍属兜底，只在 PATH 看起来
 * 「不像用户环境」时才去问 shell。
 */
function backendEnv() {
  const env = { ...process.env, DSH_HOME, NO_COLOR: '1' }
  if (needsShellPath()) {
    const fromShell = loginShellPath()
    if (fromShell) env.PATH = fromShell
  }
  return env
}

/** 当前 PATH 像是从 Finder 启动的（不含用户级目录）时返回 true。 */
function needsShellPath() {
  const current = process.env.PATH || ''
  if (!current.includes('/usr/bin')) return false
  // 只要 PATH 里出现了典型的用户级目录，就认为是从终端启动的，不必再问 shell。
  return !['.nvm', 'homebrew', '.local/bin', '.hermes', '.volta', '.bun']
    .some((marker) => current.includes(marker))
}

/**
 * 向登录 shell 要一份 PATH（结果缓存，最多问一次）。
 *
 * 为什么要给标记再截取：用户的 rc 文件常有 `echo`、版本管理器提示之类的东西会污染
 * stdout，而我们只要那一行。同时给 5 秒超时，避免某个 rc 文件卡住把应用启动拖死。
 */
let cachedShellPath
function loginShellPath() {
  if (cachedShellPath !== undefined) return cachedShellPath

  cachedShellPath = undefined
  const shell = process.env.SHELL || '/bin/zsh'
  try {
    const output = execFileSync(shell, ['-lic', 'echo "__DSH_PATH__$PATH"'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const value = output.match(/__DSH_PATH__(.+)/)?.[1]?.trim()
    if (value && value.includes('/')) cachedShellPath = value
  } catch {}
  return cachedShellPath
}

function findExecutableIn(searchPath, name) {
  for (const dir of searchPath.split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, name)
    if (isExecutable(candidate)) return candidate
  }
  return undefined
}

function isExecutable(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}


// ── 应用设置（菜单里改的那些偏好）─────────────────────────────────────────

/** 设置文件路径。和引擎用的 state.json 分开，避免互相覆盖。 */
function settingsFilePath() {
  return path.join(DESKTOP_HOME, 'settings.json')
}

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFilePath(), 'utf8'))
    const notify = raw?.notify
    if (notify !== null && typeof notify === 'object') {
      notifySettings = {
        ...NOTIFY_DEFAULTS,
        ...Object.fromEntries(
          Object.entries(notify).filter(([key]) => key in NOTIFY_DEFAULTS)
        )
      }
    }
  } catch {
    // 文件不存在或坏了都用默认值 —— 设置读不出来不该影响启动
  }
}

function saveSettings() {
  try {
    fs.mkdirSync(DESKTOP_HOME, { recursive: true })
    let existing = {}
    try {
      existing = JSON.parse(fs.readFileSync(settingsFilePath(), 'utf8')) ?? {}
    } catch {}
    const next = { ...existing, notify: notifySettings }
    const temp = `${settingsFilePath()}.tmp`
    fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    fs.renameSync(temp, settingsFilePath())
  } catch (error) {
    log('保存设置失败:', String(error?.message || error))
  }
}

/** 改一个通知设置并落盘 + 重建菜单（勾选状态要跟着变）。 */
function updateNotifySettings(patch) {
  notifySettings = { ...notifySettings, ...patch }
  saveSettings()
  refreshMenu()
  log(`通知设置：${JSON.stringify(patch)}`)
}

// ── 引擎升级器 ──────────────────────────────────────────────────────────

/**
 * 升级器实例。懒建：它需要 `bundledNodePath()`（依赖 app.getAppPath()），
 * 而那要等 app 可用之后才稳妥。
 *
 * 升级用**自带的 node + 自带的 npm**跑 —— 复用 App 里已有的运行时，不额外塞一份。
 * registry / 镜像 / 代理配置由 npm 自己读 `~/.npmrc`，所以检测和安装走同一份配置。
 */
let updaterInstance
function updater() {
  if (updaterInstance) return updaterInstance
  const node = bundledNodePath()
  if (!node) return undefined
  updaterInstance = createUpdater({
    desktopHome: DESKTOP_HOME,
    nodePath: node,
    npmCliPath: path.join(app.getAppPath(), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    // 让升级器知道「自带引擎是哪个版本」——回滚目标是具体版本号，而不是「自带」这种抽象状态
    bundledVersion: bundledEngineVersion,
    log
  })
  return updaterInstance
}

/** App 自带引擎的版本，作为「当前版本」的兜底。 */
function bundledEngineVersion() {
  const bin = bundledDshEntry()
  return bin ? engineVersion(bin) : undefined
}

/**
 * 通知设置。全部通过菜单栏「通知」调整，落盘保存。
 *
 * mode 是「什么时候通知」：
 *   always    始终通知（默认）—— 发完消息盯着窗口等结果时，你最想知道「跑完了」
 *   unfocused 仅窗口不在前台时 —— 你正看着就不打扰
 *   long      仅长任务 —— 短问答不打扰，跑得久的才叫
 */
const NOTIFY_DEFAULTS = {
  enabled: process.env.DSH_MIN_NO_NOTIFY !== '1',
  mode: 'always',
  longThresholdMs: 30_000,
  showTitle: true,
  showSummary: true,
  notifyOnInterrupt: true
}

let notifySettings = { ...NOTIFY_DEFAULTS }

/** 最近一次投递结果，显示在菜单里。 */
let lastDelivery = { at: undefined, outcome: undefined, label: undefined }

let turnWatcher

/** 界面要显示的引擎状态。 */
let engineStatus = {
  busy: false,
  phase: '',
  detail: '',
  latest: undefined,
  hasUpdate: false,
  lastError: undefined
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
  const engine = resolveEngine()
  if (!engine) {
    dialog.showErrorBox(
      '找不到 dsh 引擎',
      '这个 App 自带引擎，正常情况下不该出现这个提示。\n\n' +
        '请重新下载安装包，或用 DSH_MIN_BIN 环境变量指定 dsh 的路径。'
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

  // 自带/更新的引擎：node <bin.js> web ...；系统 dsh：dsh web ...
  const command = engine.node ?? engine.bin
  const argv = engine.node ? [engine.bin, ...args] : args

  log(`启动后端（${engine.source}）:`, command, argv.join(' '))
  log('  DSH_HOME =', DSH_HOME)
  log('  cwd      =', WORKSPACE)

  child = spawn(command, argv, {
    cwd: WORKSPACE,
    env: backendEnv(),
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
        startNotifier()
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
 * 优雅停掉后端。
 *
 * DSH 自己给了 5 秒排空宽限（`PROCESS_SHUTDOWN_TIMEOUT_MS = 5e3`），所以这里等 7 秒
 * 再升级到 SIGKILL —— 卡在 4 秒会把排空砍断、留下半截会话日志。
 */
function stopBackend({ forceAfterMs = 7000 } = {}) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) {
      child = undefined
      resolve()
      return
    }
    const force = setTimeout(() => {
      if (child && child.exitCode === null) child.kill('SIGKILL')
    }, forceAfterMs)
    child.once('exit', () => {
      clearTimeout(force)
      child = undefined
      resolve()
    })
    child.kill('SIGTERM')
  })
}

/** 用当前引擎重新拉起后端，并让窗口重新加载。 */
async function restartBackend() {
  log('重启后端…')
  await stopBackend()
  baseUrl = undefined
  startBackend(0)
}

// ── 升级流程（菜单驱动）──────────────────────────────────────────────────

/** 菜单重建：引擎状态变化后调用，让「升级到 X」这类动态项跟着变。 */
function refreshMenu() {
  try {
    buildMenu()
  } catch (error) {
    // 不吞：菜单构建失败会让人完全看不到升级入口，必须能从日志里发现
    log('菜单构建失败:', String(error?.message || error))
    console.error(error)
  }
}

function setEngineBusy(busy, phase = '', detail = '') {
  engineStatus = { ...engineStatus, busy, phase, detail }
  refreshMenu()
}

/**
 * 「检查更新」：查 npm 上的版本，和当前引擎比。
 * 只查、不改任何东西。
 */
async function checkForUpdates({ silent = false } = {}) {
  const engine = updater()
  if (!engine) {
    if (!silent) {
      dialog.showMessageBox({
        type: 'warning',
        message: '升级功能不可用',
        detail: '找不到自带的 Node 运行时，无法调用 npm。请重新安装 App。',
        buttons: ['好']
      })
    }
    return
  }

  setEngineBusy(true, '正在检查更新…')
  try {
    const result = await engine.check(bundledEngineVersion())
    if (!result.ok) {
      engineStatus = { ...engineStatus, busy: false, lastError: result.error }
      refreshMenu()
      if (!silent) {
        dialog.showMessageBox({
          type: 'warning',
          message: '检查更新失败',
          detail: String(result.error).slice(0, 600),
          buttons: ['好']
        })
      }
      return result
    }

    engineStatus = {
      busy: false,
      phase: '',
      detail: '',
      latest: result.latest,
      hasUpdate: result.hasUpdate,
      lastError: undefined
    }
    refreshMenu()

    if (!silent) {
      if (result.hasUpdate) {
        const choice = await dialog.showMessageBox({
          type: 'info',
          message: `发现新版本 ${result.latest}`,
          detail:
            `当前引擎   ${result.current}\n` +
            `可用最新   ${result.latest}\n\n` +
            `升级约需 1 分钟，期间可以继续使用。\n` +
            `升级前会先在隔离环境里验证新引擎，验证不通过不会生效。\n` +
            `完成后需要重启后端，约 2 秒不可用。`,
          buttons: ['稍后', `升级到 ${result.latest}`],
          defaultId: 1,
          cancelId: 0
        })
        if (choice.response === 1) await upgradeTo(result.latest)
      } else {
        dialog.showMessageBox({
          type: 'info',
          message: '已是最新版本',
          detail:
            `当前引擎   ${result.current}\n` +
            (result.tags?.next && result.tags.next !== result.latest
              ? `next 通道  ${result.tags.next}\n`
              : '') +
            (result.tags?.alpha && result.tags.alpha !== result.latest
              ? `alpha 通道 ${result.tags.alpha}`
              : ''),
          buttons: ['好']
        })
      }
    }
    return result
  } finally {
    if (engineStatus.busy) setEngineBusy(false)
  }
}

/**
 * 升级到指定精确版本。
 *
 * 流程：装到 staging → 在隔离 home 里跑三道关卡 → 通过才切换指针 → 询问是否重启。
 * 全程不改 dsh 一个字节，也不动正在运行的那份引擎。
 */
async function upgradeTo(version) {
  const engine = updater()
  if (!engine) return
  if (engineStatus.busy) {
    dialog.showMessageBox({ type: 'info', message: '已有升级在进行中', buttons: ['好'] })
    return
  }

  setEngineBusy(true, `正在升级到 ${version}…`, '准备中')
  try {
    const result = await engine.install(version, {
      onProgress: (p) => setEngineBusy(true, `正在升级到 ${version}…`, p.message),
      onStep: (step) => {
        const names = { version: '版本自检', dump: '配置组装', boot: '冷启动' }
        const marks = { running: '…', passed: '✓', failed: '✗' }
        log(`关卡 ${names[step.gate] ?? step.gate}: ${marks[step.status] ?? step.status} ${
          step.detail ?? ''
        }`)
      }
    })

    if (!result.ok) {
      setEngineBusy(false)
      dialog.showMessageBox({
        type: 'error',
        message: '升级失败（未生效，仍在用原来的引擎）',
        detail: `阶段：${result.phase ?? '未知'}\n\n${String(result.error ?? '').slice(0, 800)}`,
        buttons: ['好']
      })
      return
    }

    engineStatus = { ...engineStatus, hasUpdate: false, latest: undefined }
    setEngineBusy(false)

    const choice = await dialog.showMessageBox({
      type: 'info',
      message: `已升级到 ${version}`,
      detail: '需要重启后端才能生效。\n\n现在重启会中断正在执行的任务。',
      buttons: ['稍后', '立即重启'],
      defaultId: 1,
      cancelId: 0
    })
    if (choice.response === 1) {
      await restartBackend()
    } else {
      log(`引擎已切换到 ${version}，等你下次重启后端生效`)
    }
  } finally {
    setEngineBusy(false)
  }
}

/** 回滚到上一个状态。 */
async function rollbackEngine() {
  const engine = updater()
  if (!engine) return
  const previous = engine.previousState()
  if (!previous) {
    dialog.showMessageBox({ type: 'info', message: '还没有记录到上一个版本', buttons: ['好'] })
    return
  }

  const isBundled = previous === bundledEngineVersion()
  const confirm = await dialog.showMessageBox({
    type: 'question',
    message: `回滚到 ${previous}？`,
    detail:
      `上一个版本   ${previous}${isBundled ? '（App 自带）' : ''}\n` +
      '回滚只改引擎指针，不动任何已安装的文件。\n' +
      '需要重启后端才能生效。',
    buttons: ['取消', '回滚'],
    defaultId: 1,
    cancelId: 0
  })
  if (confirm.response !== 1) return

  const result = engine.rollback()
  if (!result.ok) {
    dialog.showMessageBox({
      type: 'error',
      message: '回滚失败',
      detail: String(result.error),
      buttons: ['好']
    })
    return
  }
  engineStatus = { ...engineStatus, hasUpdate: false }
  refreshMenu()

  const next = await dialog.showMessageBox({
    type: 'info',
    message: `已回滚到 ${result.version}`,
    detail: '需要重启后端才能生效。',
    buttons: ['稍后', '立即重启'],
    defaultId: 1,
    cancelId: 0
  })
  if (next.response === 1) await restartBackend()
}

// ── 轮次通知 ────────────────────────────────────────────────────────────

/**
 * 从投影缓存里读会话标题，**只用于通知文案**。
 *
 * 注意定位：读取投影缓存是「缓存」，官方明确说它的字段会随 `stateVersion` 变。
 * 所以这里只把它当**装饰**用 —— 读不到就退回 App 名当标题，
 * 绝不用它做触发判断。触发判断走的是会话 JSONL 的 turn/end（那是冻结在 v0 的持久化契约）。
 */
function sessionTitle(sessionId) {
  try {
    const file = path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const value = raw?.record?.rows?.title?.val
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
  } catch {
    return undefined
  }
}

/** 把窗口带到前台。点通知时用。 */
function focusWindow() {
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/**
 * 投递一条通知，并回报结果。
 *
 * 为什么要等事件而不是直接返回：macOS 上通知可能被系统权限拦掉，此时
 * `show()` 不会抛错、`isSupported()` 也照样返回 true —— 只有 `failed` 事件才告诉你
 * 真实结果（实测开发态会报 `UNErrorDomain 错误1`）。所以统一走这个封装，
 * 让「为什么没通知」永远有答案。
 *
 * @returns 'shown' | 'failed:…' | 'unsupported' | 'timeout'
 */
function notify({ title, body, onClick } = {}) {
  return new Promise((resolve) => {
    // 整个构造过程包在 try 里：以前这里写错一个变量名会让 Promise 抛异常、
    // 变成未捕获的 rejection —— 结果就是通知**彻底静默失效**，连日志都没有。
    // 现在任何异常都降级成「投递失败」这一条可诊断的结果。
    try {
      if (!Notification.isSupported()) {
        resolve('unsupported')
        return
      }
      let settled = false
      const done = (outcome) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(outcome)
      }
      const notification = new Notification({ title, body, silent: false })

      // 5 秒内既没 show 也没 failed，就当超时（系统可能静默丢弃）
      const timer = setTimeout(() => done('timeout'), 5000)
      notification.on('show', () => done('shown'))
      notification.on('failed', (_event, error) => done(`failed:${String(error)}`))
      if (onClick) notification.on('click', onClick)

      notification.show()
    } catch (error) {
      resolve(`failed:${String(error?.message || error)}`)
    }
  })
}

/**
 * 通知权限自检 —— 菜单里的「测试通知」。
 *
 * 它会真的发一条通知，并把投递结果（成功 / 被拦 / 原因）用对话框告诉你。
 * 因为 macOS 的通知权限只能通过「实际投递」来验证：`isSupported()` 在没授权时
 * 也返回 true，只有 `failed` 事件才说出真相。
 */
async function testNotificationPermission() {
  const supported = Notification.isSupported()
  log(`通知权限测试：isSupported=${supported}`)

  if (!supported) {
    dialog.showMessageBox({
      type: 'warning',
      message: '这台系统不支持通知',
      detail: 'Notification.isSupported() 返回 false，通知功能不可用。',
      buttons: ['好']
    })
    return
  }

  const outcome = await notify({
    title: 'DSH 通知测试',
    body: '如果你看到这条，说明通知可用。点我回到窗口。',
    onClick: focusWindow
  })
  log(`通知权限测试结果：${outcome}`)

  if (outcome === 'shown') {
    dialog.showMessageBox({
      type: 'info',
      message: '通知可用',
      detail:
        '测试通知已投递。\n\n' +
        '如果屏幕上没看到，检查「系统设置 → 通知 → DSH Desktop Min」是否被设为「无」或开了「专注模式」。',
      buttons: ['好']
    })
    return
  }

  // 失败：区分开发态和打包态，给出可执行的下一步
  const inDev = !app.isPackaged
  dialog.showMessageBox({
    type: 'warning',
    message: '通知投递失败',
    detail:
      `结果：${outcome}\n\n` +
      (inDev
        ? '当前是开发态运行（npm start）。开发态的 Electron 没有 app bundle 授权，' +
          '系统会拒绝通知并报 UNErrorDomain 错误 1 —— 这是预期行为，' +
          '用打包后的 .app 测才能验证。'
        : '请检查：\n' +
          '1. 系统设置 → 通知 → DSH Desktop Min 是否允许\n' +
          '2. 是否开了专注模式 / 勿扰\n' +
          '3. App 是否被移动过位置（移动后需要重新打开一次让系统重新登记）'),
    buttons: ['好']
  })
}

function startNotifier() {
  if (turnWatcher) return
  turnWatcher = createTurnWatcher({
    sessionsDir: path.join(DSH_HOME, 'sessions'),
    log,
    onTurnEnd: ({ sessionId, reason, durationMs, summary: summaryText }) => {
      // 每个决策都留痕 —— 否则「为什么没通知」会变成玄学问题
      if (!notifySettings.enabled) {
        log('轮次结束，但通知已关闭，跳过')
        return
      }

      const completed = reason === 'completed'

      if (!completed && !notifySettings.notifyOnInterrupt) {
        log(`轮次以 ${reason} 结束，但设置里关掉了「中断时也通知」，跳过`)
        return
      }

      // 通知方式：决定「什么时候通知」
      const focused = win && !win.isDestroyed() && win.isFocused() && !win.isMinimized()
      if (notifySettings.mode === 'unfocused' && focused) {
        log('轮次结束，窗口在前台（设置为「仅窗口不在前台时」），跳过')
        return
      }
      if (
        notifySettings.mode === 'long' &&
        (durationMs === undefined || durationMs < notifySettings.longThresholdMs)
      ) {
        log(`轮次结束，用时 ${formatDuration(durationMs) ?? '未知'} 未超过阈值，跳过`)
        return
      }

      // 通知两段式（对齐微信那种观感）：
      //   标题 = 会话标题（谁在说）   正文 = 助手回复摘要（说了什么）
      //
      // 刻意**不显示「任务完成」和用时**：正常跑完是默认预期，写在通知里是噪音；
      // 一条只有「谁 + 说了什么」的通知信息密度最高。
      // 中断则相反 —— 它是异常路径，必须说出来，所以正文直接写「任务中断」，
      // 并且**不显示那半截摘要**，免得让人误以为这轮正常跑完了。
      const title = notifySettings.showTitle ? sessionTitle(sessionId) : undefined
      const summary = notifySettings.showSummary ? summarize(summaryText) : undefined

      let body
      if (!completed) {
        body = '任务中断'
      } else if (summary !== undefined) {
        body = summary
      } else if (notifySettings.showSummary) {
        // 这轮没有文字回复（例如只调了工具），描述事实而不是伪造一个状态
        body = '本轮没有文字回复'
      } else {
        body = '' // 关掉了摘要：只留会话标题，像微信的「有一条新消息」
      }

      const titleText = title ?? 'DSH Desktop Min'
      const label = `${titleText}：${body || '(无正文)'}`

      notify({
        title: titleText,
        body,
        // 点通知就回到窗口 —— 这是桌面端相对浏览器通知的独有优势
        onClick: focusWindow
      }).then((outcome) => {
        lastDelivery = { at: Date.now(), outcome, label }
        refreshMenu() // 菜单里要显示「最近投递」
        log(
          outcome === 'shown'
            ? `通知已投递：${label}`
            : `通知投递失败(${outcome})：${label}`
        )
      })
    }
  })
  void turnWatcher.start().then(() => {
    log('轮次通知已就绪（监听会话事件流）')
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
  const engine = updater()
  const current = engine ? engine.runningVersion(bundledEngineVersion()) : bundledEngineVersion()
  const previous = engine?.previousState()
  const installed = engine ? engine.listEngines() : []

  // ── 引擎子菜单：状态只读展示 + 操作 ────────────────────────────────
  const engineItems = []

  engineItems.push({
    label: `当前引擎：${current ?? '未知'}`,
    enabled: false
  })
  engineItems.push({
    label: `自带引擎：${bundledEngineVersion() ?? '未知'}`,
    enabled: false
  })
  if (installed.length > 0) {
    engineItems.push({
      label: `已安装：${installed.map((e) => e.version).join('、')}`,
      enabled: false
    })
  }

  engineItems.push({ type: 'separator' })

  if (engineStatus.busy) {
    engineItems.push({
      label: `${engineStatus.phase}${engineStatus.detail ? ` — ${engineStatus.detail}` : ''}`,
      enabled: false
    })
  } else {
    engineItems.push({
      label: '检查更新…',
      accelerator: 'CmdOrCtrl+U',
      click: () => void checkForUpdates()
    })

    if (engineStatus.hasUpdate && engineStatus.latest) {
      engineItems.push({
        label: `升级到 ${engineStatus.latest}`,
        click: () => void upgradeTo(engineStatus.latest)
      })
    }

    if (previous) {
      // previous 现在始终是一个版本号；如果那就是自带引擎的版本，额外标注一下
      const isBundled = previous === bundledEngineVersion()
      engineItems.push({
        label: `回滚到 ${previous}${isBundled ? '（自带）' : ''}`,
        click: () => void rollbackEngine()
      })
    }

    // 已装版本：可切过去，也可删除（正在用的那个除外）
    const switchable = installed.filter((e) => !e.active)
    if (switchable.length > 0) {
      engineItems.push({ type: 'separator' })
      engineItems.push({
        label: '切换到已装版本',
        submenu: switchable.map((e) => ({
          label: `${e.version}（${Math.round(e.sizeBytes / 1048576)} MB）`,
          click: async () => {
            const confirm = await dialog.showMessageBox({
              type: 'question',
              message: `切换到引擎 ${e.version}？`,
              detail: '需要重启后端才能生效。',
              buttons: ['取消', '切换'],
              defaultId: 1,
              cancelId: 0
            })
            if (confirm.response !== 1) return
            engine.promote(e.version)
            refreshMenu()
            await restartBackend()
          }
        }))
      })

      const removable = switchable.filter((e) => e.version !== current)
      if (removable.length > 0) {
        engineItems.push({
          label: '删除旧引擎',
          submenu: removable.map((e) => ({
            label: `${e.version}（${Math.round(e.sizeBytes / 1048576)} MB）`,
            click: async () => {
              const confirm = await dialog.showMessageBox({
                type: 'warning',
                message: `删除引擎 ${e.version}？`,
                detail: '删掉后如果要再用，需要重新从 npm 下载。',
                buttons: ['取消', '删除'],
                defaultId: 1,
                cancelId: 0
              })
              if (confirm.response !== 1) return
              const removed = engine.removeEngine(e.version)
              if (!removed.ok) {
                dialog.showMessageBox({
                  type: 'error',
                  message: '删除失败',
                  detail: String(removed.error),
                  buttons: ['好']
                })
              }
              refreshMenu()
            }
          }))
        })
      }
    }

    // 只有当「当前用的不是自带引擎」时，才提供「改用自带引擎」
    if (current !== bundledEngineVersion()) {
      engineItems.push({ type: 'separator' })
      engineItems.push({
        label: `改用 App 自带引擎${bundledEngineVersion() ? `（${bundledEngineVersion()}）` : ''}`,
        click: async () => {
          const confirm = await dialog.showMessageBox({
            type: 'question',
            message: '改用 App 自带的引擎？',
            detail: '已安装的版本会保留，随时可以切回来。',
            buttons: ['取消', '改用'],
            defaultId: 1,
            cancelId: 0
          })
          if (confirm.response !== 1) return
          engine.useBundled()
          refreshMenu()
          await restartBackend()
        }
      })
    }

    if (engineStatus.lastError) {
      engineItems.push({ type: 'separator' })
      engineItems.push({
        label: '上次检查更新失败…',
        click: () =>
          dialog.showMessageBox({
            type: 'warning',
            message: '上次检查更新失败',
            detail: String(engineStatus.lastError).slice(0, 800),
            buttons: ['好']
          })
      })
    }
  }

  // ── 通知菜单：独立的顶级分块，不挂在「服务」下面 ──────────────────────
  //
  // 一二级划分原则：**一级放「开关和动作」，二级放「成组的选项」**。
  //   一级：启用通知 / 任务中断时也通知（两个独立开关）、测试通知权限（动作）、
  //         最近投递（状态）
  //   二级：通知方式（三选一）、通知内容（多选）—— 成组的偏好才有资格当二级
  const modeItems = [
    { id: 'always', label: '始终通知' },
    { id: 'unfocused', label: '仅窗口不在前台时' },
    { id: 'long', label: `仅长任务（超过 ${Math.round(notifySettings.longThresholdMs / 1000)} 秒）` }
  ].map((mode) => ({
    label: mode.label,
    type: 'radio',
    checked: notifySettings.mode === mode.id,
    click: () => updateNotifySettings({ mode: mode.id })
  }))

  const contentItems = [
    { key: 'showTitle', label: '显示会话标题' },
    { key: 'showSummary', label: '显示回复摘要' }
  ].map((entry) => ({
    label: entry.label,
    type: 'checkbox',
    checked: notifySettings[entry.key],
    click: (item) => updateNotifySettings({ [entry.key]: item.checked })
  }))

  const deliveryLabel = (() => {
    if (lastDelivery.outcome === undefined) return '最近投递：尚未发送过'
    const when = new Date(lastDelivery.at).toLocaleTimeString('zh-CN', { hour12: false })
    if (lastDelivery.outcome === 'shown') return `最近投递：${when} 成功`
    return `最近投递：${when} 失败（${lastDelivery.outcome}）`
  })()

  const notifyItems = [
    {
      label: '启用通知',
      type: 'checkbox',
      checked: notifySettings.enabled,
      click: (item) => updateNotifySettings({ enabled: item.checked })
    },
    {
      label: '任务中断时也通知',
      type: 'checkbox',
      checked: notifySettings.notifyOnInterrupt,
      click: (item) => updateNotifySettings({ notifyOnInterrupt: item.checked })
    },
    { type: 'separator' },
    { label: '通知方式', submenu: modeItems },
    { label: '通知内容', submenu: contentItems },
    { type: 'separator' },
    {
      label: '测试通知权限…',
      click: () => void testNotificationPermission()
    },
    { type: 'separator' },
    { label: deliveryLabel, enabled: false }
  ]

  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '引擎',
      submenu: engineItems
    },
    {
      label: '通知',
      submenu: notifyItems
    },
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
    {
      label: '服务',
      submenu: [
        {
          label: '重启后端',
          click: async () => {
            const confirm = await dialog.showMessageBox({
              type: 'question',
              message: '重启后端？',
              detail: '会中断正在执行的任务。',
              buttons: ['取消', '重启'],
              defaultId: 1,
              cancelId: 0
            })
            if (confirm.response === 1) await restartBackend()
          }
        },
        {
          label: '在浏览器中打开',
          click: () => {
            if (baseUrl) void shell.openExternal(baseUrl)
          }
        }
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
  turnWatcher?.stop()

  if (!ownsChild || !child || child.exitCode !== null) return

  event.preventDefault()
  log('关闭后端（SIGTERM）…')
  // 只负责「优雅」；如果壳被强杀、这里根本没机会跑，由 watchdog.js 兜底收尸。
  void stopBackend().then(() => app.quit())
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
    loadSettings()


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

    // 启动后静默检查一次更新。有新版才在「引擎」菜单里出现「升级到 X」，
    // 不弹窗、不打断 —— 检测到就够，决定权留给你。
    // 延迟一点，避免和后端启动抢资源。
    if (!process.env.DSH_MIN_NO_UPDATE_CHECK) {
      const timer = setTimeout(() => {
        void checkForUpdates({ silent: true })
      }, 8000)
      timer.unref?.()
    }
  })
}
