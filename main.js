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

const {
  app,
  BrowserWindow,
  shell,
  dialog,
  Menu,
  Tray,
  nativeImage,
  nativeTheme,
  Notification,
  session
} = require('electron')
const { spawn, execFileSync } = require('node:child_process')
const { fileURLToPath } = require('node:url')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const { createUpdater } = require('./updater')
const { PLUGIN_CATALOG, createPluginInstaller, resolvePnpmEntry } = require('./plugin-installer')
const { createTurnWatcher, formatDuration, summarize } = require('./notify')
const { createLineReader, extractAuthenticatedUrl } = require('./output-lines')
const {
  ensureCommandEntry,
  findExecutableIn,
  isExecutableFile,
  killProcessTree,
  choosePort,
  // backendEnv() 在「像是从 Finder 启动」时用它把登录 shell 的 PATH 写进去。
  // 漏掉这一项会让双击启动直接 ReferenceError —— 而且终端里跑永远发现不了，
  // 因为那时 needsShellPath() 是 false，这条分支根本不执行。
  setEnvPath
} = require('./platform')

// ── 可覆盖的配置（都有默认值，不设就是「跟官方共用」）─────────────────────

/** Desktop 自己的数据根目录。引擎等应用数据放在这里。 */
const DESKTOP_HOME = process.env.DSH_MIN_DESKTOP_HOME
  ? path.resolve(process.env.DSH_MIN_DESKTOP_HOME)
  : path.join(os.homedir(), '.dsh-desktop')

/**
 * DSH 数据目录。默认与命令行 dsh 共用 ~/.dsh，因此在停止 Web 后，Desktop 可以
 * 直接接着同一批会话继续工作。DSH_MIN_HOME 仅用于明确指定另一份数据目录。
 */
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
const DEFAULT_WORKSPACE = path.join(os.homedir(), 'Documents', 'DSH')

/**
 * 工作目录。DSH 按进程 cwd 给会话分桶（$DSH_HOME/sessions/<编码后的cwd>/），
 * 要和网页端看到同一批会话，这个路径必须和你在网页端启动 dsh 时的目录一致。
 */
const WORKSPACE = path.resolve(process.env.DSH_MIN_WORKSPACE || DEFAULT_WORKSPACE)

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
  const bundledNode = bundledNodePath()

  /**
   * 把「一个入口」配成可 spawn 的 { command, argv } 形态。
   *
   * 规则：**JS 入口必须用一个真正的 node 去加载**。dsh 的 shebang 是
   * `#!/usr/bin/env node`，而 Windows 上 spawn 一个 `.js` 文件根本不会执行 ——
   * 没有 shebang 机制，也没有执行位。所以：
   *   · 有自带 node → `node <bin.js>`
   *   · 没自带 node（只可能是开发态不完整）→ 借 Electron 自己的 Node
   *     （ELECTRON_RUN_AS_NODE=1，见 backendEnv），并在日志里说清楚
   */
  const asEngine = (bin, source) => {
    if (!/\.(?:c?js|mjs)$/i.test(bin)) return { node: undefined, bin, source }
    if (bundledNode) return { node: bundledNode, bin, source }
    log(`警告：找不到自带的 node，${source} 将借用 Electron 的 Node 运行`)
    return { node: process.execPath, bin, source, useElectronNode: true }
  }

  if (process.env.DSH_MIN_BIN) {
    return asEngine(process.env.DSH_MIN_BIN, 'DSH_MIN_BIN')
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
    if (bundledNode && fs.existsSync(bin)) {
      return { node: bundledNode, bin, source: `已升级引擎 ${version}` }
    }
  }

  // 2. 自带引擎
  const bundledBin = bundledDshEntry()
  if (bundledBin && bundledNode) {
    return { node: bundledNode, bin: bundledBin, source: `自带引擎 ${engineVersion(bundledBin)}` }
  }

  // 3-4. 开发态 / 兜底：系统里的 dsh
  //
  // 优先找「npm 包里的 lib/bin.js」这一种形态：Windows 上 PATH 里的 `dsh` 是 `dsh.cmd`，
  // spawn 它必须开 `shell: true`（Node 20.12+ 修掉 .cmd/.bat 的注入面之后就是这样），
  // 而把参数交给 cmd.exe 重新拼一遍是我们不想引入的注入面。
  // 直接找包入口、用自带 node 加载，既不需要 shell 也不会踩引号转义。
  for (const location of standardDshLocations()) {
    if (isExecutableFile(location) || fs.existsSync(location)) {
      return asEngine(location, '系统 dsh')
    }
  }

  // POSIX 上再兜最后一层：「PATH / 登录 shell 里的 dsh 命令」。
  //
  // 这一层是给版本管理器（volta / nodenv / bun）的用户留的 —— 它们的 shim 在 POSIX 上
  // 是可执行文件，直接 spawn 就行，所以原来就有这条路，不能因为 Windows 的约束把它砍掉。
  // Windows 上刻意不走这里：那边 shim 是 .cmd，理由见上。
  if (process.platform !== 'win32') {
    const fromPath = findExecutableIn(process.env.PATH || '', 'dsh')
    if (fromPath) return asEngine(fromPath, 'PATH 上的 dsh')
    const fromShell = findExecutableIn(loginShellPath() || '', 'dsh')
    if (fromShell) return asEngine(fromShell, '登录 shell 里的 dsh')
  }

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
 * 系统里（npm 全局 / 版本管理器）装着 dsh 时，它的**包入口**最可能出现的位置。
 *
 * 为什么一律指向 `@deepseek-ai/dsh/lib/bin.js`，而不是 `dsh` 这个命令本身：
 *   · POSIX 上那个 shim 是符号链接，直接找包入口可以跳过它；
 *   · Windows 上那个 shim 是 `dsh.cmd`，spawn 它必须开 `shell: true`
 *     （Node 20.12+ 修掉 .cmd/.bat 的注入面之后就是这样），而把参数交给 cmd.exe
 *     重新拼一遍是我们不想引入的注入面。
 * 直接找包入口、用自带 node 加载，两种平台一条路径走通，也不需要 shell。
 *
 * 两种平台的目录约定差得很远，所以这里明确分支，不做「猜」。
 */
function standardDshLocations() {
  const home = os.homedir()
  const moduleRoots = []
  const shimLocations = []

  if (process.platform === 'win32') {
    // npm 的全局 prefix 默认在 %APPDATA%\npm；pnpm 的全局目录在 %LOCALAPPDATA%\pnpm；
    // Volta 在 %LOCALAPPDATA%\Volta；官方 node 安装包的全局 prefix 在 Program Files\nodejs。
    const bases = [
      process.env.APPDATA && path.join(process.env.APPDATA, 'npm'),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'pnpm'),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Volta'),
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'nodejs')
    ]
    for (const base of bases) {
      if (base) moduleRoots.push(path.join(base, 'node_modules'))
    }
  } else {
    const binDirs = [
      '/usr/local/bin',
      '/opt/homebrew/bin',
      path.join(home, '.npm-global', 'bin'),
      path.join(home, '.local', 'bin'),
      path.join(home, '.volta', 'bin'),
      path.join(home, '.bun', 'bin'),
      path.join(home, '.nodenv', 'shims')
    ]
    // bin 目录同级往上找 lib/node_modules —— npm 全局包的落点
    for (const dir of binDirs) moduleRoots.push(path.join(dir, '..', 'lib', 'node_modules'))

    // nvm：每个已安装版本一个 node_modules
    try {
      const nvmVersions = path.join(home, '.nvm', 'versions', 'node')
      for (const version of fs.readdirSync(nvmVersions)) {
        moduleRoots.push(path.join(nvmVersions, version, 'lib', 'node_modules'))
      }
    } catch {}

    moduleRoots.push(
      '/usr/local/lib/node_modules',
      '/opt/homebrew/lib/node_modules',
      path.join(home, '.npm-global', 'lib', 'node_modules'),
      path.join(home, '.local', 'lib', 'node_modules')
    )

    // 另一类候选：版本管理器的 shim 本身（POSIX 上是可执行文件，可以直接 spawn）。
    // 这一路是原有能力，保留 —— 有些安装（volta / nodenv / bun）只暴露 shim，
    // 包目录并不在标准 node_modules 位置上。
    for (const dir of binDirs) shimLocations.push(path.join(dir, 'dsh'))
  }

  const locations = []
  for (const root of moduleRoots) {
    locations.push(path.join(root, '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  }
  return [...locations, ...shimLocations]
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
 *
 * Windows 上没有这一层（见 needsShellPath 的说明）；另外：
 *   · PATH 必须按平台语义写（`Path` / `PATH`），否则会造出两个键，子进程可能拿到旧值；
 *   · 借用 Electron 的 Node 跑 JS 入口时，要显式打开 ELECTRON_RUN_AS_NODE。
 */
function backendEnv(engine) {
  const env = { ...process.env, DSH_HOME, NO_COLOR: '1' }
  if (engine?.useElectronNode) env.ELECTRON_RUN_AS_NODE = '1'
  if (needsShellPath()) {
    const fromShell = loginShellPath()
    if (fromShell) setEnvPath(env, fromShell)
  }
  return env
}

/** 当前 PATH 像是从 Finder 启动的（不含用户级目录）时返回 true。 */
function needsShellPath() {
  // Windows 上没有对应问题：进程环境是从注册表展开的，从开始菜单/资源管理器启动
  // 一样拿得到完整的用户 PATH，不存在 launchd 那种「最小 PATH」。
  if (process.platform === 'win32') return false
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
  // 只有 POSIX 有「登录 shell 的 PATH」这个概念；Windows 上走注册表那套，见 needsShellPath。
  if (process.platform === 'win32') return undefined
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

// 找命令、判断可执行这两件事已经移到 platform.js（Windows 上必须按 PATHEXT 判，
// 而不是 POSIX 的 X_OK 位），这里不再保留本地实现。


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

/** 插件操作串行化：pnpm 不应同时改同一个 web profile。 */
let setupBusy = false
let pluginInstallerInstance

// ── 运行状态 ────────────────────────────────────────────────────────────

let child
let win
let baseUrl
/** 本次启动是否由我们拉起了后端（决定退出时要不要收尸）。 */
let ownsChild = false
let quitting = false
/** 是否正在为换引擎而主动停后端 —— 期间后端退出是预期行为，不是故障。 */
let swapping = false

const log = (...args) => console.log('[dsh-min]', ...args)

/**
 * 初始化插件安装器懒建。
 *
 * DSH 的公开 plugin 命令会从 PATH 调用 pnpm，所以把 App 自带的
 * `node_modules/.bin` 放到最前面。这不依赖用户是否预装 Node/pnpm。
 */
function pluginInstaller() {
  if (pluginInstallerInstance) return pluginInstallerInstance
  const appModules = path.join(app.getAppPath(), 'node_modules')
  const bundledNode = bundledNodePath()
  pluginInstallerInstance = createPluginInstaller({
    resolveEngine,
    dshHome: DSH_HOME,
    workspace: WORKSPACE,
    executableDirs: [
      ensurePluginPnpmDir(),
      path.join(appModules, '.bin'),
      bundledNode ? path.dirname(bundledNode) : undefined
    ],
    log
  })
  return pluginInstallerInstance
}

/**
 * electron-builder 会打包 pnpm 的 CLI，但会丢掉 `node_modules/.bin/pnpm` 链接。
 * DSH 的公开 plugin 命令通过 PATH 执行 `pnpm`，因此在 App 外的可写目录里准备一个
 * 入口，然后把那个目录塞进 PATH。
 *
 * 平台差异（这里踩过坑，都是实测结论）：
 *   · **Windows 不能建符号链接** —— 那需要管理员权限或开发者模式，普通机器会直接报
 *     「此操作需要管理员权限」，于是向导里勾任何插件都会失败（`dsh plugin` 找不到
 *     pnpm）。所以 Windows 上写一个 `pnpm.cmd`，内容是 `"<自带的 node>" "<pnpm 入口>" %*`；
 *     写普通文件不需要任何特权。
 *   · Windows 上命令必须是带 PATHEXT 后缀的真实文件，`pnpm` 这个名字本身不是命令。
 * App 更新后目标路径变了，下次使用时会原子替换。
 */
function ensurePluginPnpmDir() {
  try {
    const require = createRequire(path.join(app.getAppPath(), 'package.json'))
    // pnpm 只导出包根，而根入口正好就是 package.json。
    // 不能 resolve `pnpm/package.json`，那会被 package exports 拒绝。
    const manifest = require.resolve('pnpm')
    const scriptPath = resolvePnpmEntry(path.dirname(manifest))
    if (!scriptPath) {
      log('准备自带 pnpm 失败:在 pnpm 包里找不到入口脚本')
      return undefined
    }

    const nodePath = bundledNodePath()
    if (process.platform === 'win32' && !nodePath) {
      // shim 必须由一个真实 node 来执行脚本；借 Electron 内置 Node 会踩回
      // utility process 那条老路（见文件头关于 --expose-internals 的说明）。
      log('准备自带 pnpm 失败:找不到自带的 node，无法生成 Windows 命令 shim')
      return undefined
    }

    const binDir = path.join(DESKTOP_HOME, 'bin')
    ensureCommandEntry({ binDir, name: 'pnpm', scriptPath, nodePath })
    return binDir
  } catch (error) {
    log('准备自带 pnpm 失败:', String(error?.message || error))
    return undefined
  }
}

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
      {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      }
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
/** 剥掉 ANSI 转义，避免颜色码把 URL 切碎。 */
const stripAnsi = (s) => s.replace(/\u001B\[[0-9;]*m/g, '')

const BACKEND_START_TIMEOUT_MS = 45_000

/**
 * 首选后端端口。
 *
 * 为什么不再用 `--port 0` 每次随机：dsh 的浏览器会话 cookie 名是
 * `dsh-auth-<sha256(host:port)>` —— **端口进了名字**。随机端口意味着每次启动都在
 * `127.0.0.1` 这个域下留一条新 cookie，而没有任何人会去删旧的；攒到 64 条约 3.4KB 时，
 * 叠加客户端模块那条超长的 `/plugins/??…` 合并 URL，整个请求头会顶穿 Node 默认的
 * 16KB 上限，服务端回 **HTTP 431**，页面表现成「插件全加载不出来」。
 * 固定端口让 origin 稳定，从根上不再累积（原先靠 pruneAuthCookies 兜着，那个仍然保留）。
 *
 * 被占用就回落 0（让系统分配），所以不会和你在终端里跑的 dsh 抢端口；
 * `DSH_MIN_PORT=0` 可以强制回到随机端口。
 * 43140 是避开 DSH Desktop 自己占用的 43127~43129 之后随便挑的高位端口。
 */
const PREFERRED_BACKEND_PORT = Number(process.env.DSH_MIN_PORT ?? 43140)

/** 选一个后端端口：优先固定端口，占用了就回落 0。探测失败也回落 0，绝不因此启动失败。 */
function backendPort() {
  return choosePort(PREFERRED_BACKEND_PORT)
}

/**
 * 启动当前选中的引擎，等它输出一整行带凭据的 URL 后才算成功。
 * 换引擎时由调用方处理失败，这样可以先恢复旧指针再向用户报错。
 */
function startBackend(port) {
  return new Promise((resolve) => {
    let settled = false
    let startupFailure
    let recentOutput = ''
    let startupTimer

    const finish = (result) => {
      if (settled) return
      settled = true
      if (startupTimer) clearTimeout(startupTimer)
      resolve(result)
    }

    const engine = resolveEngine()
    if (!engine) {
      finish({
        ok: false,
        error:
          '找不到 dsh 引擎。这个 App 正常情况下应自带引擎；请重新安装，或用 DSH_MIN_BIN 指定入口。'
      })
      return
    }

    try {
      fs.mkdirSync(WORKSPACE, { recursive: true })
    } catch (error) {
      finish({
        ok: false,
        error: `无法创建工作目录 ${WORKSPACE}：${String(error.message || error)}`
      })
      return
    }

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

    let backend
    try {
      backend = spawn(command, argv, {
        cwd: WORKSPACE,
        env: backendEnv(engine),
        stdio: ['ignore', 'pipe', 'pipe'],
        // Windows:后端是 node.exe(控制台程序),而壳是 GUI 进程。不给这个标志,
        // Windows 会给它分配一个控制台窗口 —— 用户看到的是启动时凭空多一个黑窗。
        windowsHide: true
      })
    } catch (error) {
      finish({ ok: false, error: String(error.message || error) })
      return
    }
    child = backend
    ownsChild = true

    const onLine = (line) => {
      if (!baseUrl) {
        const url = extractAuthenticatedUrl(stripAnsi(line))
        if (url) {
          baseUrl = url
          log('后端就绪:', url.replace(/token=.*/, 'token=<hidden>'))
          void loadIntoWindow(url)
          startNotifier()
          finish({ ok: true, url, engine: engine.source })
        }
      }
    }

    const stdoutLines = createLineReader(onLine)
    const stderrLines = createLineReader(onLine)
    const onChunk = (reader, buf) => {
      const text = buf.toString()
      process.stdout.write(text)
      recentOutput = `${recentOutput}${stripAnsi(text)}`.slice(-1200)
      reader.push(buf)
    }
    backend.stdout.on('data', (buf) => onChunk(stdoutLines, buf))
    backend.stderr.on('data', (buf) => onChunk(stderrLines, buf))

    backend.on('error', (error) => {
      startupFailure = String(error.message || error)
      finish({ ok: false, error: startupFailure })
    })

    // 后端起得来才需要看门狗；spawn 失败时没有子进程可看。
    if (backend.pid !== undefined) startWatchdog(backend.pid)

    backend.on('exit', (code, signal) => {
      log('后端退出:', { code, signal })
      if (child === backend) child = undefined
      if (!settled) {
        const detail = recentOutput.trim().slice(-600)
        finish({
          ok: false,
          error:
            startupFailure ||
            `dsh 在就绪前退出（code=${code} signal=${signal}）${detail ? `：${detail}` : ''}`
        })
        return
      }
      // swapping：这次退出是我们自己为换引擎而杀的，属于正常流程。
      // 少了这个判断，restartBackend() 会命中下面这条「报错并退出应用」——
      // 也就是「立即重启」实际上是坏的：它会弹一个「后端已退出」然后把 App 关掉。
      if (!quitting && !swapping) {
        // 后端没了，窗口留着也没意义；正常退出路径由 before-quit 处理。
        dialog.showErrorBox(
          '后端已退出',
          `dsh 进程结束了（code=${code} signal=${signal}）。请重新启动应用。`
        )
        app.quit()
      }
    })

    startupTimer = setTimeout(() => {
      startupFailure =
        `等待 dsh 启动超时（${BACKEND_START_TIMEOUT_MS} ms）` +
        (recentOutput.trim() ? `：${recentOutput.trim().slice(-600)}` : '')
      // 用进程树终止：卡住的后端往往已经派生了一堆子进程（工具调用、rg 等），
      // 只杀它自己的 pid 会留下一片孤儿。
      if (!killBackendProcess(backend)) {
        finish({ ok: false, error: startupFailure })
      }
    }, BACKEND_START_TIMEOUT_MS)
    startupTimer.unref?.()
  })
}

/**
 * 停掉后端。
 *
 * **POSIX**：dsh 自己给了 5 秒排空宽限（`PROCESS_SHUTDOWN_TIMEOUT_MS = 5e3`，由
 * `process.on('SIGTERM')` 驱动），所以这里等 7 秒再升级到 SIGKILL —— 卡在 4 秒会把
 * 排空砍断、留下半截会话日志。
 *
 * **Windows**：没有"可送达的 SIGTERM"这回事 —— `child.kill('SIGTERM')` 在那边等价于
 * `TerminateProcess`，dsh 那个信号处理器根本不会被调用，5 秒排空**必然不执行**。
 * 所以那边不做「优雅」的假装，直接 `taskkill /t /f`，重点是 `/t`：dsh 会派生工具调用的
 * 子进程（pwsh、rg 等），只杀它自己的 pid 会留下一堆活着的孙子进程占着工作目录。
 * 真正的兜底不是这里，而是会话日志的追加式+原子写（dsh 自己用 MoveFileEx 保证）。
 */
function stopBackend({ forceAfterMs = 7000 } = {}) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) {
      child = undefined
      resolve()
      return
    }
    const target = child

    const force = setTimeout(() => {
      if (target.exitCode === null) killBackendProcess(target)
    }, forceAfterMs)

    target.once('exit', () => {
      clearTimeout(force)
      if (child === target) child = undefined
      resolve()
    })

    if (!killBackendProcess(target, 'SIGTERM')) {
      // 连信号都发不出去（进程已经没了之类的）：直接当作已结束，别把退出流程挂死
      clearTimeout(force)
      if (child === target) child = undefined
      resolve()
    }
  })
}

/**
 * 结束一个后端进程，**连同它在 Windows 上派生的子孙进程**。
 *
 * @returns 是否成功发起了终止动作（false 表示进程已经不存在了）
 */
function killBackendProcess(target, signal = 'SIGKILL') {
  if (!target || target.pid === undefined || target.exitCode !== null) return false
  // Windows：taskkill /t /f 一把收完。POSIX：保持原来的信号语义。
  if (process.platform === 'win32' && killProcessTree(target.pid, { force: true })) return true
  try {
    target.kill(signal)
    return true
  } catch {
    return false
  }
}

/** 用当前引擎重新拉起后端，并让窗口重新加载。 */
/**
 * 用当前引擎重新拉起后端。
 *
 * 窗口先交给接管页 —— 否则用户会盯着一个已经死掉的 dsh 页面看 2 秒。
 * 新后端起好之后，startBackend 的 onChunk 会把 dsh 页面接回来。
 */
async function restartBackend({
  phase = '正在重启引擎',
  rollbackOnFailure = false,
  recoverOnFailure,
  recoveryPhase = '更改后启动失败，正在恢复原状态',
  recoveryMessage = '更改后启动失败，已恢复原状态'
} = {}) {
  log('重启后端…')
  await showSplash({ phase, detail: '窗口马上回来', percent: null, steps: [] })
  let started
  let switchError
  swapping = true
  try {
    await stopBackend()
    baseUrl = undefined
    started = await startBackend(await backendPort())
    if (started.ok) return started

    switchError = started.error
    if (rollbackOnFailure || typeof recoverOnFailure === 'function') {
      const restoredPointer =
        typeof recoverOnFailure === 'function' ? await recoverOnFailure() : updater()?.rollback()
      if (restoredPointer?.ok) {
        pushSplash({
          phase:
            typeof recoverOnFailure === 'function'
              ? recoveryPhase
              : `新引擎启动失败，正在恢复 ${restoredPointer.version}`,
          detail: '窗口马上回来',
          percent: null,
          steps: []
        })
        baseUrl = undefined
        const restored = await startBackend(await backendPort())
        if (restored.ok) {
          log(`启动失败，已恢复原状态: ${switchError}`)
          void dialog.showMessageBox({
            type: 'warning',
            message:
              typeof recoverOnFailure === 'function'
                ? recoveryMessage
                : '新引擎启动失败，已恢复原版本',
            detail: String(switchError).slice(0, 900),
            buttons: ['好']
          })
          refreshMenu()
          return { ok: false, rolledBack: true, error: switchError }
        }
        switchError = `${switchError}\n\n恢复原状态后仍无法启动：${restored.error}`
      } else {
        switchError = `${switchError}\n\n恢复原状态失败：${restoredPointer?.error ?? '恢复功能不可用'}`
      }
    }
  } finally {
    swapping = false
  }

  dialog.showErrorBox('启动 dsh 失败', String(switchError || '未知错误').slice(0, 1200))
  app.quit()
  return { ok: false, error: switchError }
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
            `升级前会先在隔离环境里验证新引擎，验证不通过不会生效。\n` +
            `点「升级」后窗口会被接管显示进度，期间界面不可用，\n` +
            `正在执行的任务会被中断。`,
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
 * 流程：装到 staging → 在隔离 home 里跑三道关卡 → 通过才切换指针 → 换后端。
 * 全程不改 dsh 一个字节。
 *
 * 窗口接管：确认升级后立刻把窗口切成 splash.html，下载和校验的全程都显示真实进度。
 *
 * 一条重要的顺序保证 —— **下载和校验期间绝不碰正在跑的旧后端**：
 * `install()` 的三道关卡跑在隔离 home 里，跟旧后端不冲突。所以只要 install
 * 没返回 ok，旧引擎就是完好无损的，失败时把 dsh 页面切回去就行，用户连回滚
 * 都不需要。只有 install 成功之后才动旧后端。
 */
async function upgradeTo(version) {
  const engine = updater()
  if (!engine) return
  if (engineStatus.busy) {
    dialog.showMessageBox({ type: 'info', message: '已有升级在进行中', buttons: ['好'] })
    return
  }

  setEngineBusy(true, `正在升级到 ${version}…`, '准备中')

  // 旧地址留着 —— 失败时用它把 dsh 页面切回来。
  const previousUrl = baseUrl
  const gateState = {}
  const currentVersion = engine.runningVersion(bundledEngineVersion())

  try {
    await showSplash({
      version: currentVersion ? `${currentVersion} → ${version}` : version,
      phase: `正在升级到 ${version}`,
      detail: '准备中',
      percent: null,
      steps: gateSteps(),
      error: ''
    })

    const result = await engine.install(version, {
      onProgress: (p) => {
        setEngineBusy(true, `正在升级到 ${version}…`, p.message)
        pushSplash({ phase: `正在升级到 ${version}`, detail: p.message, percent: null })
      },
      onStep: (step) => {
        log(`关卡 ${GATE_LABELS[step.gate] ?? step.gate}: ${step.status} ${step.detail ?? ''}`)
        gateState[step.gate] = step.status
        pushSplash({
          phase: '正在验证新引擎',
          detail: `${GATE_LABELS[step.gate] ?? step.gate}${step.detail ? ` · ${step.detail}` : ''}`,
          percent: null,
          steps: gateSteps(gateState)
        })
      }
    })

    if (!result.ok) {
      setEngineBusy(false)
      // 失败也往接管页推一份，这样即使对话框被关掉，页面上也留着错误痕迹。
      pushSplash({
        phase: '升级失败',
        detail: `阶段：${result.phase ?? '未知'}`,
        percent: null,
        error: String(result.error ?? '').slice(0, 600)
      })
      // 旧引擎全程没动过，直接把 dsh 页面切回去。
      if (previousUrl) loadIntoWindow(previousUrl)
      dialog.showMessageBox({
        type: 'error',
        message: '升级失败（未生效，仍在用原来的引擎）',
        detail: `阶段：${result.phase ?? '未知'}\n\n${String(result.error ?? '').slice(0, 800)}`,
        buttons: ['好']
      })
      return
    }

    engineStatus = { ...engineStatus, hasUpdate: false, latest: undefined }
    if (result.pruned?.removed?.length) {
      log(
        `已清理 ${result.pruned.removed.length} 个旧引擎（${result.pruned.removed.join('、')}），` +
          `释放约 ${Math.round(result.pruned.freedBytes / 1048576)} MB`
      )
    }
    setEngineBusy(false)
    log(`引擎指针已切换到 ${version}，正在拉起新后端`)
    const restarted = await restartBackend({
      phase: `正在启动 ${version}`,
      rollbackOnFailure: true
    })
    if (restarted.ok) log(`引擎已切换到 ${version}`)
  } finally {
    if (engineStatus.busy) setEngineBusy(false)
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
      '确认后窗口会被接管几秒用于重启引擎，正在执行的任务会被中断。',
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
  await restartBackend({ phase: `正在回滚到 ${result.version}`, rollbackOnFailure: true })
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
        (process.platform === 'win32'
          ? '如果屏幕上没看到，检查「设置 → 系统 → 通知」里 DSH Desktop Min 是否被关掉，' +
            '以及是否开了「专注助手」。另外：Windows 的通知要求 App 有开始菜单快捷方式，' +
            '所以要用安装版（NSIS）验证，portable / 未安装时可能收不到。'
          : '如果屏幕上没看到，检查「系统设置 → 通知 → DSH Desktop Min」是否被设为「无」或开了「专注模式」。'),
      buttons: ['好']
    })
    return
  }

  // 失败：区分开发态和打包态，给出可执行的下一步
  const inDev = !app.isPackaged
  const guidance = process.platform === 'win32'
    ? inDev
      ? '当前是开发态运行（npm start）。开发态的 Electron 没有开始菜单快捷方式和\n' +
        'AppUserModelID 登记，Windows 通常会直接丢弃 toast —— 这是预期行为，\n' +
        '用安装后的版本（NSIS）测才能验证。'
      : '请检查：\n' +
        '1. 设置 → 系统 → 通知 → DSH Desktop Min 是否允许\n' +
        '2. 是否开了「专注助手」/ 勿扰\n' +
        '3. 是否用的是安装版（portable 包没有开始菜单快捷方式，Windows 不认）'
    : inDev
      ? '当前是开发态运行（npm start）。开发态的 Electron 没有 app bundle 授权，' +
        '系统会拒绝通知并报 UNErrorDomain 错误 1 —— 这是预期行为，' +
        '用打包后的 .app 测才能验证。'
      : '请检查：\n' +
        '1. 系统设置 → 通知 → DSH Desktop Min 是否允许\n' +
        '2. 是否开了专注模式 / 勿扰\n' +
        '3. App 是否被移动过位置（移动后需要重新打开一次让系统重新登记）'

  dialog.showMessageBox({
    type: 'warning',
    message: '通知投递失败',
    detail: `结果：${outcome}\n\n${guidance}`,
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

/**
 * 清掉历史遗留的浏览器会话 cookie。
 *
 * 为什么必须做：后端用 `--port 0` 启动，**每次都是一个新端口**，而 dsh 的浏览器
 * 会话 cookie 名字是 `dsh-auth-<sha256(host:port)>` —— 端口进了哈希，所以每换一次
 * 端口就是**一条全新的、永不过期的 cookie**，旧的没有任何人会去删。
 *
 * 它们全挂在 `127.0.0.1` 这一个域下，于是每次请求都会把它们**全部**带回服务端。
 * 实测攒到 64 条（约 3.4KB）时，加上 `/plugins/??…` 那条超长的客户端模块合并 URL，
 * 整个请求头块超过 Node 默认的 16KB 上限，服务端直接返回 **431 Request Header
 * Fields Too Large**。表现是页面能打开、但插件全加载不出来：
 *
 *     Failed to load plugins
 *     failed to import loader entry …: client-modules: bundle script /plugins/??… failed to load
 *
 * 这个故障是**渐进**的：跑几十次之后才开始，极容易被误判成「dsh 升级把界面弄坏了」。
 *
 * 做法上直接清空整个前缀：启动时我们本来就是拿一枚**全新的、进程级的** token 去换
 * cookie，从来不依赖旧 cookie 存活，所以全删是安全且最省事的。删完这次导航会立刻
 * 重新种下当前端口那一条。
 */
async function pruneAuthCookies() {
  try {
    const ses = session.defaultSession
    const all = await ses.cookies.get({})
    const stale = all.filter((c) => c.name.startsWith(AUTH_COOKIE_PREFIX))
    if (stale.length === 0) return
    for (const cookie of stale) {
      // 域是 host-only（127.0.0.1），端口不参与 cookie 匹配，所以这个 URL 够用。
      await ses.cookies.remove(`http://${cookie.domain.replace(/^\./, '')}${cookie.path}`, cookie.name)
    }
    log(`清理了 ${stale.length} 条历史会话 cookie（每个后端端口一条，会一直累积）`)
  } catch (error) {
    // 清不掉不该拦住启动 —— 最坏就是继续累积，行为退回到修复之前。
    log('清理历史 cookie 失败:', String(error?.message || error))
  }
}

async function loadIntoWindow(url) {
  if (!win || win.isDestroyed()) return
  // 先清再说：必须在导航**之前**完成，否则可能把即将种下的新 cookie 一起删掉。
  await pruneAuthCookies()
  if (!win || win.isDestroyed()) return
  win.loadURL(url)
  win.show()
}

// ── 接管页（splash）──────────────────────────────────────────────────────
//
// 下载 / 校验 / 重启引擎期间，窗口里换成 App 自带的 splash.html。
//
// 为什么不做覆盖层动画：窗口本来就是一个 loadURL，直接把内容**换掉**比
// 「抓当前画面当位图盖上去、再交叉淡化」简单得多，也不需要去碰
// BaseWindow / WebContentsView。而且接管页是真实页面，能显示真实进度、
// 显示错误、以后还能放按钮，不受「一帧一帧画」的限制。
//
// 数据通道刻意做成单向：主进程 executeJavaScript 调 window.__dshSplash.update()。
// 不引入 preload —— 那个窗口的 webPreferences 是为**远端** dsh 页面设的
// （sandbox + contextIsolation + 无 preload），给本地页面开 IPC 就等于给远端页面
// 也开了一个洞。

const SPLASH_FILE = path.join(__dirname, 'splash.html')

/** dsh 浏览器会话 cookie 的前缀；后面拼的是 sha256(host:port) 的 base64url。 */
const AUTH_COOKIE_PREFIX = 'dsh-auth-'

/** 三道验证关卡的中文名，splash 和日志共用。 */
const GATE_LABELS = { version: '版本自检', dump: '配置组装', boot: '冷启动' }

/**
 * 把窗口切到接管页。
 *
 * 调用点必须保证：**能走到这里就一定能走回来** —— 失败路径要把 dsh 页面切回去，
 * 否则用户会永远停在接管页上。
 */
async function showSplash(state = {}) {
  if (!win || win.isDestroyed()) return
  try {
    await win.loadFile(SPLASH_FILE)
    await pushSplash(state)
  } catch (error) {
    log('接管页加载失败:', String(error?.message || error))
  }
}

/** 往接管页推状态。页面没加载好时记一条日志；失败绝不冒泡影响升级流程。 */
function pushSplash(state) {
  if (!win || win.isDestroyed()) return
  try {
    const payload = JSON.stringify(state).replace(/</g, '\\u003c')
    win.webContents
      .executeJavaScript(`window.__dshSplash && window.__dshSplash.update(${payload})`, true)
      .catch((error) => log('接管页更新失败:', String(error?.message || error)))
  } catch (error) {
    log('接管页更新异常:', String(error?.message || error))
  }
}

/** 接管页上的关卡状态，按顺序攒着，每次推全量。 */
function gateSteps(status = {}) {
  return Object.entries(GATE_LABELS).map(([id, name]) => ({
    name,
    status: status[id] ?? 'pending'
  }))
}

// ── 首次启动向导：可选插件 ──

const SETUP_FILE = path.join(__dirname, 'setup.html')

function installationReceipt() {
  try {
    const executable = app.getPath('exe')
    const stat = fs.statSync(executable)
    // 覆盖安装 App 会换掉可执行文件的 inode / 出生时间；普通重启不会。
    return `${app.getVersion()}:${executable}:${stat.ino}:${stat.birthtimeMs}`
  } catch {
    return `${app.getVersion()}:${app.getPath('exe')}`
  }
}

function shouldShowSetup() {
  if (process.env.DSH_MIN_SKIP_SETUP === '1' || process.env.DSH_MIN_ATTACH) return false
  try {
    const settings = JSON.parse(fs.readFileSync(settingsFilePath(), 'utf8'))
    return settings?.setupReceipt !== installationReceipt()
  } catch {
    return true
  }
}

function markSetupComplete() {
  try {
    fs.mkdirSync(DESKTOP_HOME, { recursive: true })
    let existing = {}
    try {
      existing = JSON.parse(fs.readFileSync(settingsFilePath(), 'utf8')) ?? {}
    } catch {}
    const temp = `${settingsFilePath()}.tmp`
    fs.writeFileSync(
      temp,
      `${JSON.stringify({ ...existing, setupReceipt: installationReceipt() }, null, 2)}\n`,
      'utf8'
    )
    fs.renameSync(temp, settingsFilePath())
  } catch (error) {
    log('保存初始化标记失败:', String(error?.message || error))
  }
}

/**
 * 当前页是不是 App 自带的初始化页。
 *
 * 它同时是两处的门禁：`pushSetupState`（往页面推插件清单）和 `handleSetupIntent`
 * （处理「跳过 / 安装已选并继续」）。所以这个判断一旦出错，症状是**列表空白 + 按钮
 * 全都没反应** —— 用户直接卡在向导里出不来。
 *
 * 为什么不能直接比字符串（这里踩过真坑）：Windows 上 `file:` URL 的 pathname 形如
 * `/C:/Users/…`（正斜杠、带前导斜杠），而 `path.join` 给的是 `C:\Users\…`（反斜杠），
 * 于是**永远不相等**。必须两边都过一遍 `fileURLToPath` 再比，它同时解决正/反斜杠、
 * 前导斜杠、以及路径里的空格（打包后路径含 `DSH Desktop Min`，URL 里是 `%20`）。
 */
function isSetupPage() {
  if (!win || win.isDestroyed()) return false
  try {
    const current = new URL(win.webContents.getURL())
    if (current.protocol !== 'file:') return false
    const currentPath = path.resolve(fileURLToPath(current))
    const expected = path.resolve(SETUP_FILE)
    // Windows 的路径大小写不敏感（盘符大小写尤其不固定）
    return process.platform === 'win32'
      ? currentPath.toLowerCase() === expected.toLowerCase()
      : currentPath === expected
  } catch {
    return false
  }
}

function setupCatalogForPage() {
  return PLUGIN_CATALOG.map(({ id, name, subtitle, description }) => ({
    id,
    name,
    subtitle,
    description
  }))
}

function pushSetupState(state) {
  if (!win || win.isDestroyed() || !isSetupPage()) return
  try {
    const payload = JSON.stringify(state).replace(/</g, '\\u003c')
    win.webContents
      .executeJavaScript(`window.__dshSetup && window.__dshSetup.update(${payload})`, true)
      .catch((error) => log('初始化页更新失败:', String(error?.message || error)))
  } catch (error) {
    log('初始化页更新异常:', String(error?.message || error))
  }
}

async function showSetup() {
  if (!win || win.isDestroyed()) return
  try {
    await win.loadFile(SETUP_FILE)
    pushSetupState({ plugins: setupCatalogForPage(), busy: false, message: '' })
    // 这一行是刻意留的：初始化页出问题时（列表空白 / 按钮没反应）用户只会说
    // 「这里没有内容，而且跳不过去」，而成功推送状态原本是完全静默的 ——
    // 有这行就能一眼分清「状态没推过去」还是「推过去了但点击没被接住」。
    log(`初始化页已就绪（${PLUGIN_CATALOG.length} 个可选插件，等待用户选择）`)
  } catch (error) {
    log('初始化页加载失败:', String(error?.message || error))
  }
}

async function undoSetupTransactions(transactions) {
  const errors = []
  for (const transaction of [...transactions].reverse()) {
    const result = await pluginInstaller().undo(transaction)
    if (!result.ok) errors.push(result.error)
  }
  return errors.length === 0 ? { ok: true } : { ok: false, error: errors.join('\n') }
}

async function handleSetupIntent(url) {
  if (!isSetupPage() || setupBusy) return
  let intent
  try {
    intent = new URL(url)
  } catch {
    return
  }
  if (intent.hostname !== 'continue') return

  const requested = (intent.searchParams.get('plugins') || '').split(',').filter(Boolean)
  const selected = [...new Set(requested)]
  if (selected.some((id) => !PLUGIN_CATALOG.some((plugin) => plugin.id === id))) return

  // 同上：记下意图，否则「按钮点了没反应」永远只能靠猜
  log(`初始化页收到意图：${intent.hostname}（选中 ${selected.length} 个插件）`)

  setupBusy = true
  const transactions = []
  try {
    for (let index = 0; index < selected.length; index += 1) {
      const plugin = PLUGIN_CATALOG.find((entry) => entry.id === selected[index])
      pushSetupState({
        busy: true,
        message: `正在安装 ${plugin.name}（${index + 1}/${selected.length}）…`
      })
      const result = await pluginInstaller().change(plugin.id, 'install')
      if (!result.ok) {
        const recovered = await undoSetupTransactions(transactions)
        pushSetupState({
          busy: false,
          error:
            `安装 ${plugin.name} 失败：${String(result.error).slice(0, 650)}` +
            (!result.recovered && result.recoveryError
              ? `\n\n恢复失败：${String(result.recoveryError).slice(0, 350)}`
              : '') +
            (!recovered.ok ? `\n\n恢复先前选项失败：${String(recovered.error).slice(0, 350)}` : '')
        })
        return
      }
      if (result.changed) transactions.push(result.transaction)
    }

    const started = await restartBackend({
      phase: selected.length > 0 ? '插件已安装，正在启动 DSH' : '正在启动 DSH',
      recoverOnFailure:
        transactions.length > 0 ? () => undoSetupTransactions(transactions) : undefined,
      recoveryPhase: '插件导致启动失败，正在恢复初始状态',
      recoveryMessage: '选装插件导致 DSH 启动失败，已恢复为未安装状态'
    })
    if (started.ok || started.rolledBack) {
      markSetupComplete()
      scheduleAfterStartup()
    }
  } finally {
    setupBusy = false
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

/**
 * Windows：把原生标题栏也去掉，只留系统画的三个窗口按钮。
 *
 * 做法与社区版 DSH Desktop 一致（`titleBarStyle:'hidden'` + `titleBarOverlay`，
 * 底板全透明 → 系统只画三个字符，那条地归应用，于是没有系统灰底横条）。
 *
 * 两条踩过的坑，写在这里避免以后重复调试：
 *
 *   1. **不要调 `win.setMenuBarVisibility(false)`。** 实测它与 `autoHideMenuBar: true`
 *      同时用时，overlay 画的窗口按钮会整个消失（多次测量像素数为 0）。菜单栏收起这件事
 *      `autoHideMenuBar` 一个人就能干（按 Alt 唤出），不需要那句额外的调用。
 *      （作者本人实机确认过：只留这三个按钮的观感是好的，所以这条配置就这么定下来。）
 *   2. **不要靠屏幕截图数像素来判断按钮在不在** —— 截图受窗口层级、坐标、DPI 影响，
 *      在这个窗口上多次给出互相矛盾的结论。可靠办法是给窗口发 `WM_NCHITTEST`：
 *      命中关闭/最大化/最小化会分别返回 HTCLOSE(20)/HTMAXBUTTON(9)/HTMINBUTTON(8)。
 */
const WINDOWS_TITLEBAR_HEIGHT = 36

/**
 * Windows 系统按钮的宽度兜底值。
 * 优先用 Chromium 的 `env(titlebar-area-*)` 现算（跟着全屏/DPI/语言方向自动变），
 * 拿不到时才回落到这个常量；140 也是 DSH Desktop 用的值。
 */
const WINDOWS_CAPTION_FALLBACK_WIDTH = 140

/**
 * 系统按钮的就地样式。`color: '#00000000'`（全透明底板）是「融入」的关键；
 * symbolColor 跟随深浅色，否则深色主题下按钮看不见。
 */
function windowsTitleBarOverlay(isDark) {
  return {
    color: '#00000000',
    symbolColor: isDark ? '#f3f4f6' : '#202124',
    height: WINDOWS_TITLEBAR_HEIGHT
  }
}

/**
 * 把窗口底色与系统按钮样式对齐到当前主题。
 * 只跟随系统主题（nativeTheme）；dsh 界面内部自己切主题不会同步 ——
 * 那需要从渲染进程读主题再回传，而我们刻意不给页面开 IPC（见 pushSplash 的说明）。
 */
function applyWindowChromeTheme(target) {
  if (!target || target.isDestroyed()) return
  const isDark = nativeTheme.shouldUseDarkColors
  try {
    target.setBackgroundColor(isDark ? '#171513' : '#ffffff')
    if (process.platform === 'win32') target.setTitleBarOverlay(windowsTitleBarOverlay(isDark))
  } catch (error) {
    log('同步窗口外观失败:', String(error?.message || error))
  }
}

/**
 * 原生标题栏被隐藏之后，Windows 上要补两件事。
 *
 * 1. **给 dsh 的会话顶栏让出右侧空间**：系统按钮浮在内容右上角（约 140px），
 *    而 dsh 恰好把 ⋯ / 面板开关放在那儿，不让开就会被盖住、点不到。
 *    选择器用上游的**语义锚点** `data-slot`（实测这份 dsh 里有 21 个），不是哈希类名。
 * 2. **交互元素排除拖拽**：拖拽条横跨整条顶栏，按钮/输入框必须能点到。
 */
function windowsChromeCss() {
  const caption = `calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, calc(100vw - ${WINDOWS_CAPTION_FALLBACK_WIDTH}px)))`
  return `
  /* 会话顶栏：右侧避开系统按钮（+8px 视觉间隙） */
  [data-slot="conversation.session.header"] > header,
  header[data-slot="conversation.session.header"] {
    padding-right: calc(${caption} + 8px) !important;
  }

  /* 顶栏里的交互元素不参与拖拽 */
  button, a, input, select, textarea, [role="button"] {
    -webkit-app-region: no-drag !important;
  }
`
}

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
 * 两个平台都要：系统标题栏都没了，Chromium 不会给内容区自动拖拽能力
 * （实测裸窗口里所有元素的 `-webkit-app-region` 都是 none，dsh 自己也不设置）。
 * 几何按平台分开，因为「系统占了哪块地方」不同：
 *
 *   macOS：红绿灯在**左上**（横向约占 x≈10~72）
 *     → left 80 / height 24 / 右侧留 120 给头部按钮，pointer-events: auto。
 *
 *   Windows：窗口按钮在**右上**（约占最右 140px，由 titleBarOverlay 浮在内容上）
 *     → 从最左铺到 `right: captionWidth`，height 36（与系统按钮同高）。
 *       必须 `pointer-events: none`：拖拽条横跨整条顶栏，而 dsh 的侧栏品牌标就在这条
 *       带子里（实测 y≈6~66），不穿透的话那个按钮就点不到了。
 *       宽度用 `env(titlebar-area-*)` 现算 —— 全屏时没有系统按钮，它会自动变成 0。
 */
function installDragRegion(target) {
  const isMac = process.platform === 'darwin'
  const isWindows = process.platform === 'win32'
  if (!isMac && !isWindows) return
  const geometry = isMac
    ? `{
        el.style.left = '80px'
        el.style.right = 'auto'
        const width = window.innerWidth - 80 - 120   // 右侧留 120px 给头部按钮
        el.style.width = Math.max(0, width) + 'px'
        el.style.display = width > 40 ? 'block' : 'none'
      }`
    : `{
        el.style.left = '0'
        // 让开系统按钮那一块；全屏时 env 会给出 0，自动铺满
        el.style.right =
          'calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, calc(100vw - ${WINDOWS_CAPTION_FALLBACK_WIDTH}px)))'
        el.style.width = 'auto'
        el.style.display = 'block'
      }`

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
              height: '${isMac ? 24 : WINDOWS_TITLEBAR_HEIGHT}px',
              background: 'transparent',
              // macOS 靠几何避让；Windows 必须穿透，否则会吃掉底下按钮的点击
              pointerEvents: '${isMac ? 'auto' : 'none'}',
              userSelect: 'none'
            })
            el.style.setProperty('-webkit-app-region', 'drag')
            document.body.appendChild(el)
          }
          ${geometry}
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
    // 两个平台都把系统标题栏去掉，让内容延伸到窗口顶部；
    // Windows 再用 titleBarOverlay 把三个窗口按钮「浮」回内容右上角（底板全透明）。
    // 系统只画那三个字符，其余那条地归应用 —— 这就是没有系统灰底横条的来源。
    // macOS 不需要 overlay：那边红绿灯本来就浮在内容上。
    frame: !isMac,
    titleBarStyle: 'hidden',
    ...(isMac ? {} : { titleBarOverlay: windowsTitleBarOverlay(nativeTheme.shouldUseDarkColors) }),
    // Windows：菜单栏默认收起，按 Alt 才唤出。
    // 只靠 `autoHideMenuBar` —— **不要**再调 `setMenuBarVisibility(false)`（见上方注释第 1 条）。
    ...(isMac ? {} : { autoHideMenuBar: true }),
    webPreferences: {
      // 加载的是远端(loopback)页面，必须保持隔离，不给 Node 能力。
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  })

  win.once('ready-to-show', () => win.show())

  // ⚠️ 这里**刻意不调** `win.setMenuBarVisibility(false)`（同时也去掉了 Windows 自绘标题栏）。
  //
  // 实测（Electron 44 + Windows 11 26100）：`autoHideMenuBar: true` 与
  // `setMenuBarVisibility(false)` 同时使用时，`titleBarOverlay` 画的窗口按钮会**整个消失**
  // —— 表现为窗口没有最小化/关闭按钮，只能 Alt+F4。四个变体的像素计数：
  //     只 autoHideMenuBar                → 按钮在
  //     只 setMenuBarVisibility(false)    → 按钮在
  //     两个一起用                         → 按钮 0 个像素（消失）
  // 而「先收起菜单栏、再补一次 setTitleBarOverlay」这种补救时灵时不灵（同一配置两次分别测到
  // 有/无），是竞态、不可依赖。
  //
  // 所以这里只留 `autoHideMenuBar: true`：菜单栏照样默认收起（按 Alt 唤出），
  // 而且重建菜单也不会让它冒出来 —— 这个选项本身管的就是这件事，不需要那句多余的调用。
  // 社区版 DSH Desktop 那句 setMenuBarVisibility(false) 之所以没坏事，是因为它随后还会在
  // 主题同步路径里重设 overlay；我们没有那条路径（刻意不开 IPC），就不去踩这个坑。

  // 系统主题变了要重新对齐窗口底色与系统按钮符号色，否则深色下按钮看不见。
  // （dsh 界面内部自己切主题不会走到这里，那条路需要渲染进程回传，我们没有开 IPC。）
  nativeTheme.on('updated', () => applyWindowChromeTheme(win))

  // 外链交给系统浏览器，窗口内不开新窗口。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('dsh-setup://')) return { action: 'deny' }
    if (url.startsWith('http://127.0.0.1:')) return { action: 'allow' }
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 只允许留在本机 loopback 上，防止被导航到外部站点。
  win.webContents.on('will-navigate', (event, url) => {
    // 初始化页不拥有 preload/IPC，只能通过这个自定义 URL 表达意图。
    // 必须同时校验「当前页就是 App 自带插件页」，远端 DSH 页无法借此调用。
    if (url.startsWith('dsh-setup://')) {
      event.preventDefault()
      if (isSetupPage()) void handleSetupIntent(url)
      return
    }
    if (!url.startsWith('http://127.0.0.1:')) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })

  // 等 DOM 就绪后再注入，避免样式被后续渲染覆盖。
  win.webContents.on('did-finish-load', () => {
    // 两套平台专属样式，各自只管自己的平台：
    //   macOS   —— 侧栏顶部给红绿灯让位（否则品牌标压在按钮下面）
    //   Windows —— 会话顶栏右侧给系统按钮让位 + 交互元素排除拖拽
    if (isMac) win.webContents.insertCSS(TRAFFIC_LIGHT_CSS).catch(() => {})
    else win.webContents.insertCSS(windowsChromeCss()).catch(() => {})
    installDragRegion(win)
  })

  // 渲染进程的加载/导航事件全部留痕。
  //
  // 这不是调试残留：判断「换引擎时页面到底是原地重连还是偷偷重载了」只能靠它。
  // 原地重连是设计的默认路径（前端自带指数退避重连），重载则会丢掉会话内状态，
  // 两者的日志长得完全不一样 —— 前者一行没有，后者必然出现 did-start-loading。
  const traceNavigations = process.env.DSH_MIN_TRACE_NAV === '1'
  if (traceNavigations) {
    win.webContents.on('did-start-loading', () => log('  [nav] did-start-loading'))
    win.webContents.on('did-finish-load', () => log('  [nav] did-finish-load'))
    win.webContents.on('did-fail-load', (_e, code, desc, url) =>
      log(`  [nav] did-fail-load ${code} ${desc} ${url}`)
    )
    win.webContents.on('did-start-navigation', (_e, url, isInPlace, isMainFrame) =>
      log(`  [nav] did-start-navigation inPlace=${isInPlace} main=${isMainFrame}`)
    )
    win.webContents.on('render-process-gone', (_e, details) =>
      log(`  [nav] render-process-gone ${details?.reason}`)
    )
    win.webContents.on('dom-ready', () => log('  [nav] dom-ready'))
  }

  // 临时诊断：打印循环回环地址上的失败请求，用来定位客户端模块包加载不出来。
  if (process.env.DSH_MIN_TRACE_NET === '1') {
    const ses = win.webContents.session
    ses.webRequest.onCompleted({ urls: ['*://127.0.0.1:*/*'] }, (details) => {
      if (details.statusCode >= 400 || details.url.includes('/plugins/')) {
        log(`  [net] ${details.statusCode} ${details.url.slice(0, 90)}…`)
      }
    })
    ses.webRequest.onErrorOccurred({ urls: ['*://127.0.0.1:*/*'] }, (details) => {
      log(`  [net] ERROR ${details.error} ${details.url.slice(0, 90)}…`)
    })
  }

  // ── 关窗 ≠ 退出：Windows 上收进托盘 ──────────────────────────────────
  //
  // 关掉窗口就把整个应用带走，会连带打断正在跑的长任务 —— 而桌面端留在后台本来就是
  // 用户预期（macOS 的系统习惯也是如此：关窗不退出应用）。
  //
  // **只有在托盘确实建起来之后才这么做**：Windows 上没有托盘图标就藏起来，等于把应用
  // 变成「人间蒸发」，只能在任务管理器里找。托盘没建起来（图标读取失败等）时保持
  // 「关窗即退出」的老行为，绝不把用户困住。
  //
  // 真正的退出路径有两条，都仍然有效：托盘菜单「退出」、以及任何 app.quit()
  // （`before-quit` 会先置 `quitting`，这里据此放行）。
  win.on('close', (event) => {
    if (quitting) return
    if (process.platform !== 'win32' || !tray) return
    event.preventDefault()
    win.hide()
    hintBackgroundOnce()
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

    // 这里原本还有「切换到已装版本」和「删除旧引擎」两个子菜单。
    // 引擎目录现在只保留「当前 + 上一个」（见 updater.js 的 pruneEngines），
    // 于是「非当前的那个已装版本」永远就是回滚目标本身 —— 两个子菜单都成了
    // 跟「回滚到 X」重复的入口，索性去掉，菜单只剩一条明确的路径。

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
          await restartBackend({
            phase: `正在启动 App 自带引擎`,
            rollbackOnFailure: true
          })
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
    // macOS 的应用菜单（关于/服务/隐藏/退出）由系统约定提供；
    // Windows 没有这一层，必须自己给一个「文件 → 退出」，否则菜单里根本没有退出入口。
    ...(isMac
      ? [{ role: 'appMenu' }]
      : [
          {
            label: '文件',
            submenu: [{ role: 'quit', label: '退出' }]
          }
        ]),
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

  // 菜单栏的显隐交给窗口选项 `autoHideMenuBar`（见 createWindow 里的说明）：
  // 这里**不要**调 setMenuBarVisibility，那会连带把 titleBarOverlay 的窗口按钮干掉。
  // 重建菜单不会让菜单栏冒出来 —— autoHideMenuBar 管的就是这个。
}

// ── 托盘（Windows）───────────────────────────────────────────────────────
//
// 菜单栏收起来之后，功能不能跟着一起藏没：托盘右键是 Windows 用户习惯的入口。
// 这里只放最常用的几项 —— 完整的菜单仍在，按 Alt 就能看到。
//
// macOS 不做托盘：那边有系统菜单栏，App 菜单本身就是系统约定的一部分，
// 再加一个托盘图标反而是多余的。

let tray

/**
 * 「收进托盘」的首次提示：只弹一次（每次启动算一次）。
 *
 * 关窗之后窗口不见了、任务栏也没了，如果不说一声，用户会以为应用崩了或者被关了 ——
 * 而实际上后端还在跑、长任务还在继续。所以第一次收进托盘时用气泡说明一下怎么找回。
 */
let backgroundHintShown = false

function hintBackgroundOnce() {
  if (backgroundHintShown) return
  backgroundHintShown = true
  log('窗口已收进托盘，应用继续在后台运行（后端与长任务不受影响）')
  try {
    tray?.displayBalloon?.({
      title: 'DSH Desktop Min 仍在后台',
      content: '长任务会继续执行。左键点托盘图标唤回窗口，右键可完全退出。'
    })
  } catch (error) {
    // 气泡只是个提示，失败不影响任何功能
    log('托盘气泡提示失败:', String(error?.message || error))
  }
}

/** 托盘图标：打包后 build/icon.png 也在包里（见 electron-builder.yml 的 files）。 */
function trayIconPath() {
  return path.join(__dirname, 'build', 'icon.png')
}

function createTray() {
  if (process.platform !== 'win32' || tray) return
  try {
    const icon = nativeImage.createFromPath(trayIconPath())
    if (icon.isEmpty()) {
      log('托盘图标读取失败，跳过托盘:', trayIconPath())
      return
    }
    tray = new Tray(icon.resize({ width: 16, height: 16 }))
    tray.setToolTip('DSH Desktop Min')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '显示窗口', click: () => focusWindow() },
        { type: 'separator' },
        { label: '检查更新…', click: () => void checkForUpdates() },
        { label: '测试通知权限…', click: () => void testNotificationPermission() },
        { type: 'separator' },
        { label: '退出', click: () => app.quit() }
      ])
    )
    // 左键直接唤回窗口：双击托盘图标没反应是 Windows 上最常见的困惑之一
    tray.on('click', () => focusWindow())
  } catch (error) {
    log('创建托盘失败:', String(error?.message || error))
  }
}

// ── 生命周期 ────────────────────────────────────────────────────────────

function scheduleAfterStartup() {
  if (!process.env.DSH_MIN_NO_UPDATE_CHECK) {
    const timer = setTimeout(() => {
      void checkForUpdates({ silent: true })
    }, 8000)
    timer.unref?.()
  }

  if (process.env.DSH_MIN_TEST_UPGRADE) {
    const target = process.env.DSH_MIN_TEST_UPGRADE
    const delay = Number(process.env.DSH_MIN_TEST_UPGRADE_DELAY ?? 6000)
    log(`[测试] ${delay}ms 后触发升级流程 → ${target}`)
    const timer = setTimeout(() => void upgradeTo(target), delay)
    timer.unref?.()
  }
}

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
  else if (shouldShowSetup()) void showSetup()
  else void restartBackend({ phase: '正在启动 DSH' })
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
  // Windows 的 toast 通知要求进程有一个 AppUserModelID，并且系统里存在与之匹配的
  // 开始菜单快捷方式（NSIS 安装包会建）。少了它，`isSupported()` 仍然返回 true，
  // 但投递会被系统静默丢弃 —— 这正是「测试通知」按钮存在的意义。
  if (process.platform === 'win32') app.setAppUserModelId('com.dsh.desktopmin')

  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })

  app.whenReady().then(async () => {
    loadSettings()


    const startupUpdater = updater()
    const reconciled = startupUpdater?.reconcilePointers()
    if (reconciled?.corrected?.length) {
      log(`启动校正：清理失效的引擎指针（${reconciled.corrected.join('、')}）`)
    }

    // 收掉历史累积：以前每次升级都只写指针、不删旧目录，所以装了多个版本的
    // 用户这里会被一次性清理到「当前 + 上一个」。只能保留两个是设计，不是妥协 ——
    // 能回滚的只有一步，第三代留着纯占磁盘（一个约 280MB）。
    const startupPrune = startupUpdater?.pruneEngines()
    if (startupPrune?.removed?.length) {
      log(
        `启动清理：删掉 ${startupPrune.removed.length} 个旧引擎（${startupPrune.removed.join('、')}），` +
          `释放约 ${Math.round(startupPrune.freedBytes / 1048576)} MB`
      )
    }

    buildMenu()
    createWindow()
    createTray()

    // 冷启动也走接管页。
    //
    // 原来 createWindow() 之后窗口会先 show 一块空白，一直等到 startBackend 从
    // stdout 解析出 URL 才 loadURL —— 中间那 ~2 秒是白屏。同一个 splash.html
    // 顺手把这段也接管了：先显示「正在启动引擎」，就绪后 loadIntoWindow 自然切走。
    //
    // DSH_MIN_ATTACH 不走这条：它接的是别人已经在跑的实例，没有引擎可等。
    if (process.env.DSH_MIN_ATTACH) {
      // 接入一个已经在跑的实例（跳过自己拉起后端）。
      // 那个实例的 token 只存在于它自己的启动输出里，所以必须由你显式提供。
      attachToExisting(process.env.DSH_MIN_ATTACH)
    } else if (shouldShowSetup()) {
      await showSetup()
      return
    } else {
      const engine = resolveEngine()
      await showSplash({
        version: engine ? engine.source : '',
        phase: '正在启动引擎',
        detail: '',
        percent: null,
        steps: []
      })

      // 优先用固定端口（见 PREFERRED_BACKEND_PORT 的说明），被占用才回落随机端口。
      // 孤儿后端由 watchdog.js 负责（壳一死就收尸），这里不用管。
      const started = await startBackend(await backendPort())
      if (!started.ok) {
        dialog.showErrorBox('启动 dsh 失败', String(started.error || '未知错误').slice(0, 1200))
        app.quit()
        return
      }
    }
    scheduleAfterStartup()
  })
}
