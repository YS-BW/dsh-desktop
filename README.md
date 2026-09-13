# dsh-desktop

把**官方** DeepSeek Harness Web UI 装进一个原生 macOS 窗口 —— **零补丁，插件可选**。

> A minimal Electron shell for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
> It ships the stock web UI in a native window with **zero patches and optional plugins**, and shares
> sessions/config with the official `dsh` CLI. Engine updates come straight from npm, so upgrading
> DSH never requires rebuilding the app.

---

## 它是什么

一个 Electron 壳（`main.js` + `updater.js` + `plugin-installer.js` + `notify.js` + `watchdog.js`）。
它**不重新实现任何界面**，也**不修改 dsh 的任何文件**：
窗口里加载的就是 `dsh web` 提供的那个官方 Web UI，和你浏览器里看到的是同一套前端。

```
Electron 壳  ──spawn──>  node <dsh>/lib/bin.js web --no-open --host 127.0.0.1 --port 0
     │                              │
     │  ← 读 stdout 拿到 URL ← ──────┘  打印 "dsh web: http://127.0.0.1:PORT/?token=..."
     └─ 把那个 URL 加载进窗口
```

壳与 dsh 之间只使用这些**公开约定**：

| 约定 | 内容 |
|---|---|
| 命令行 | `web --no-open --host 127.0.0.1 --port <n>` |
| 插件命令 | `plugin --profile web <pnpm args>`、`--profile web --dump-config` |
| 环境变量 | `DSH_HOME`（数据目录）、进程 cwd（工作目录） |
| stdout | 启动时那一行 `dsh web: <带 token 的 URL>` |

核心启动链只依赖这些公开约定；通知和桌面样式还会读取会话日志并使用 Web UI 的稳定结构，
所以升级器会在切换前做兼容性验证，桌面增强部分仍需随上游版本回归测试。

壳额外补的是网页做不到的那部分：

- **原生通知** —— 一轮跑完弹系统通知，点一下回到窗口（[见下文](#原生通知一轮跑完提醒你)）
- **初始化可选插件** —— 首次安装或覆盖重装时可以一次性选装，默认全部不勾选
- **菜单栏升级引擎** —— 检测 / 升级 / 回滚，不依赖任何 dsh 插件；升级期间窗口由自带接管页接管
- **窗口拖拽区、macOS 红绿灯让位** —— 修掉官方 Web UI 当桌面应用时的两个手感问题
- **后端生命周期** —— 壳一死，后端进程跟着死，不留孤儿
- **图标** —— 白底 + 从官方包里取的黑色鲸鱼（[见下文](#图标纯白底板--纯黑官方鲸鱼)）

## 安装

从 [Releases](../../releases) 下载 DMG，拖进「应用程序」即可。App **自带引擎**，
所以下载后不需要预装 Node.js 或 dsh。

> **首次打开**：包没有做代码签名与公证，macOS 会拦住。任选其一：
> - 右键点 App → **打开** → 再点「打开」
> - 或执行一次：`xattr -dr com.apple.quarantine "/Applications/DSH Desktop Min.app"`

## 初始化时选装插件

首次启动 App，或 App 被覆盖重装后，启动 DSH 之前会先显示一次选装页。
它是初始化流程的一步，**不是插件管理器，也不在菜单栏保留入口**。
两个选项默认都不勾选，点「跳过」或「继续」就直接启动原生 DSH。

首版可选：

| 页面名称 | 实际 npm 包 | 用途 |
|---|---|---|
| DSH Market（dsh-market） | `dshmarket` | 在 DSH 内浏览和管理更多社区插件 |
| Better Sidebar | `dsh-better-sidebar` | 增加类 VS Code 的右侧边栏 |

`dsh-better-slide` 没有可安装的同名包，所以此处接入已发布的 `dsh-better-sidebar`。

安装链只调用 DSH 公开命令：

```text
dsh plugin --profile web add <package>
dsh --profile web --dump-config
```

选中的插件会先安装并组装整棵 profile 配置，通过后再启动后端。如果配置或实际启动失败，
壳会在内部用相反的公开 CLI 操作恢复本次安装前状态。此后插件更新、卸载与其他管理由 DSH 自己负责；
壳不会直接改 DSH 的 `package.json` 或源码。

## 引擎：自带一份 + 菜单里从 npm 升级

这是本项目的核心设计，为了同时拿到「下载即用」和「升级不用重装」：

| | 位置 | 作用 |
|---|---|---|
| **自带引擎** | `App/Contents/Resources/app/node_modules/` | 打进安装包，保证双击就能用，无需预装任何东西 |
| **升级的引擎** | `~/.dsh-desktop/engines/<版本>/` | 在 App **外面**，从 npm 拉，多个版本可共存 |

启动时按这个顺序取引擎（`main.js` 的 `resolveEngine`）：

```
1. ~/.dsh-desktop/current 指向的版本   ← 升级过的（优先）
2. App 自带的一份                       ← 保证开箱即用
3. DSH_MIN_BIN 环境变量                 ← 调试用
4. 系统里的 dsh（PATH / 标准位置 / 登录 shell）  ← 开发态与兜底
```

### 升级入口：菜单栏「引擎」

```
引擎
  当前引擎：0.1.5-rc.1              （只读）
  自带引擎：0.1.5-rc.1              （只读）
  已安装：0.1.5-rc.1
  ─────────────
  检查更新…                    ⌘U
  升级到 0.1.5-rc.2                  ← 检测到新版才出现
  ─────────────
  回滚到 0.1.5-rc.1（自带）           ← 有上一个版本才出现
  ─────────────
  改用 App 自带引擎
```

引擎目录**只保留两个**：当前在用的、和上一个（回滚用）。升级切换完会立刻删掉更旧的，
启动时也会收一次历史遗留 —— 以前每次升级只写指针不删目录，装过好几个版本的机器
会在这里被一次性清理干净。

App 启动后 8 秒会**静默检查一次**更新：有新版才在菜单里出现「升级到 X」，**不弹窗、不打断**。

### 升级过程做了什么

```
① 检测    npm view @deepseek-ai/dsh dist-tags --json
② 安装    npm install @deepseek-ai/dsh@<精确版本> --prefix <staging>
          --save-exact --ignore-scripts
③ 关卡    在隔离 DSH_HOME 里验证新引擎：
            --version                     包完整、入口能加载
            --profile web --dump-config   整棵 profile 插件树能组装
            冷启动一次                     真能起来并打印启动 URL
④ 提升    staging 改名 → engines/<版本>/，写 current 指针
⑤ 重启    窗口被接管页接走，停旧后端、起新后端，就绪后交回 dsh
```

关卡约 5 秒；安装视 npm 缓存而定，约 10 秒到 1 分钟。

**关卡不通过就什么都不改**：删掉 staging，继续用原来的引擎 —— 而且**下载和校验期间根本没碰过正在跑的那个后端**，所以失败是零成本的，窗口直接切回 dsh 页面就行，连回滚都不需要。

### 升级时窗口被接管（splash.html）

点「升级」之后，窗口里显示的不再是 dsh，而是 App 自带的 `splash.html`：

```
正在升级到 0.1.5-rc.2
0.1.5-rc.1 → 0.1.5-rc.2
[▓▓▓▓▓░░░░░░░░░░░]            ← 不确定态走马灯（时长可长可短，不自作主张）
正在从 npm 安装 @deepseek-ai/dsh@0.1.5-rc.2…
● 版本自检    ● 配置组装    ● 冷启动    ← 三道关卡实时变 ✓
```

**为什么不做「覆盖层动画」**：窗口本来就是一个 `loadURL`，把内容**换掉**比「抓当前画面当位图盖上去、再交叉淡化」简单得多，也不用去碰 `BaseWindow` / `WebContentsView`。而且接管页是真实页面 —— 能显示真实进度、真实报错，以后还能放按钮，不受「一帧一帧画」的限制。

**为什么进度条是不确定态**：引擎冷启动实测约 2.1 秒，加上 npm 安装和页面加载，总时长在不同机器上差很多。动画自己不知道要转多久，所以不做假进度，改由事件收尾（新后端 stdout 就绪 → `loadIntoWindow`）。

**数据通道刻意是单向的**：主进程 `executeJavaScript` 调用本地页更新状态，**不引入 preload**。那个窗口的 `webPreferences` 是为**远端** dsh 页面设的（`sandbox` + `contextIsolation` + 无 preload），给本地页面开 IPC 就等于给远端页面也开了一个洞。初始化页的按钮只能导航到白名单化的 `dsh-setup://` 意图，主进程同时校验当前页必须是 App 内置的初始化页。

**同一个页面顺手解决了冷启动白屏**：原来 `createWindow()` 之后窗口先 show 一块空白，一直等到后端从 stdout 报出 URL 才 `loadURL` —— 中间那 ~2 秒是白屏。现在先显示「正在启动引擎」，就绪后自然切走。

<details>
<summary>为什么不让页面原地重连、省掉这次重载</summary>

其实**做得到**，而且前端本来就有这套机制：`dsh-client-connection/lib/client.js` 带 500ms 起步、上限 10 秒的指数退避重连，界面上还有现成的「重连 / 已恢复」横幅组件。

实测也成立 —— 把后端进程在活页面底下换掉（同端口、新进程、新 token），窗口**零导航事件**，ESTABLISHED 连接直接转到新后端 pid，UI 一点没变。前提是端口不变：cookie 名是 `dsh-auth-<sha256(host:port)>`，而且**跨进程有效**（实测旧 cookie 打新进程是 200，不带 cookie 是 401）。

但有个硬问题：**页面跑的还是旧引擎发下来的客户端代码**。`dsh-client-modules` 把这些代码打包成

```
/plugins/??<包名>/client.js,…&rev=<sha1 内容哈希前 12 位>
```

由服务端下发，`rev` 对不上时客户端**不会自己去拿新的**。而版本号和「客户端变没变」没有可靠映射 —— 实测同一 base 版本只动 rc 号（`0.1.5-rc.1 → rc.2`），8 个客户端包里就有 1 个变了，恰好是 `dsh-client-ui-chat`（主界面）。

所以跨版本原地重连会得到「新服务端 + 旧界面」这种最难查的错配。接管页这条路的取舍很明确：**不省那次重载，换永远正确。**

</details>

### 两条铁律

**一、版本化目录，绝不碰正在运行的那份。**

dsh 运行时会用 `await import()` 延迟加载模块（装插件、profile 热重载都会触发）。如果升级去动它脚下的文件，那些 import 会失败，或者加载到新旧混合的状态。所以新版本装到 `engines/<新版本>/`，正在跑的那份全程只读，切换只改 `current` 这个指针文件。

**二、升级由外壳驱动，不是 dsh 插件。**

dsh 插件活在**要被替换的那个进程**里，让它编排自己的替换等于进程自杀式自我更新。外壳在 dsh 外面，才能干净地停后端、换指针、重启。

### 回滚

「上一个版本」记的是**具体版本号**，不是「自带」这种抽象状态：

- 升级前用的是自带引擎 → `previous` 记的是自带引擎的版本号（如 `0.1.5-rc.1`），
  菜单显示「回滚到 0.1.5-rc.1（自带）」，回滚即清掉指针
- 升级前用的是某个已装引擎 → 菜单显示「回滚到 0.1.5-rc.1」，回滚即切指针过去

回滚是**交换语义**（滚回去之后，刚才那个版本变成新的「上一个版本」），所以误操作可以再滚回来。

回滚**只改指针，不动任何已安装的文件**，所以不会丢东西。
App 覆盖更新后还会重新校验这两个指针：如果旧回退版本既没有安装目录、也不再是当前 App
的自带版本，就会清掉这条失效记录，菜单不会继续显示一个实际无法启动的回退目标。

### 为什么这些都只依赖公开接口

检测和安装交给 npm（复用 App 自带的 node + npm，不额外塞运行时）。
验证只用三个官方 CLI 能力：`--version`、`--profile web --dump-config`、`web`。

**一个字节都不改 dsh，不装任何补丁、不依赖任何内部 API。** 所以上游怎么升级都不会破坏这套升级器。

### 为什么必须带一个「真正的 Node」

dsh 的 web profile 默认 `patchReload: "live"`，启动时会去建 Cordis 的 HMR 服务，而它需要
Node 的内部模块加载器（`--expose-internals`）。

Electron 把 dsh 跑在内置 Node 的 utility process 里时，这个标志**进不了 Node 的选项解析器**，
HMR 构造失败会直接带崩整个 profile 启动（报错原文：`--expose-internals is required for HMR service`）。
社区版为此专门写了一个 `hmr-fallback` 插件来顶替那个服务。

**本项目用真正的 Node 二进制加载 dsh**，标志正常生效，官方 HMR 直接可用 ——
所以这里**一个插件都不需要**。

### 为什么关掉 asar

打包时 `asar: false`。原因：自带引擎的启动方式是 `node <bin.js>`，而 node 二进制
**不认识 asar 虚拟文件系统**（那是 Electron 给自己内置 Node 加的能力）。只要 `bin.js`
或它 require 的模块被塞进 `app.asar`，启动就会失败。关掉 asar 后一切都在真实路径上。

## 和官方 CLI 共用会话与配置

默认 `DSH_HOME` 指向 `~/.dsh`，和命令行 `dsh` **完全共用**，所以：

- 会话历史互通（两边都能看到对方建的会话）
- `settings.yaml`、`.credentials.yaml` 互通
- 装的插件互通

**但要注意会话是按工作目录分桶的**：DSH 用 `$DSH_HOME/sessions/<编码后的 cwd>/` 存，
所以「能看到哪些会话」由进程的工作目录决定，而不是只看 `DSH_HOME`。

> ⚠️ 一个会话归属于一个后端进程，**不是一个共享的文件**。桌面端和浏览器各自拉起独立后端时，
> 那是两个不同的会话——浏览器不会实时同步桌面端的对话。想要同一个会话，就得接到同一个后端上。

> ⚠️ **不要同时运行两个后端**。DSH 的工作区索引（`$DSH_HOME/storages/workspace.json`）是
> home 级的单个文件，两个进程同时写会让会话掉进 Ungrouped（上游
> [discussion #1485](https://github.com/deepseek-ai/deepseek-harness/discussions/1485)）。

## 配置（环境变量，都有默认值）

| 变量 | 默认 | 作用 |
|---|---|---|
| `DSH_MIN_HOME` | `~/.dsh` | DSH 数据目录。默认与命令行 `dsh` 共用 |
| `DSH_MIN_WORKSPACE` | 见下 | 工作目录。决定会话分桶，必须与你网页端启动 dsh 时的目录一致 |
| `DSH_MIN_DESKTOP_HOME` | `~/.dsh-desktop` | 本 App 自己的数据根目录（更新引擎、初始化完成标记等） |
| `DSH_MIN_BIN` | 自动解析 | 直接指定 dsh 入口，跳过引擎解析链 |
| `DSH_MIN_TOP_PAD` | `30` | macOS 红绿灯顶部留白（像素），嫌挤或嫌空可以调 |
| `DSH_MIN_ATTACH` | — | 接入一个已在运行的实例（需要它带 token 的启动 URL） |
| `DSH_MIN_SKIP_SETUP` | — | `1` 时跳过初始化选装页，供自动化测试和调试使用 |
| `DSH_MIN_TRACE_NAV` | — | `1` 时打印渲染进程的导航事件，用来判断页面有没有偷偷重载 |
| `DSH_MIN_TRACE_NET` | — | `1` 时打印 loopback 上的失败请求（≥400）和 `/plugins/` 请求 —— 定位 431 就靠它 |
| `DSH_MIN_TEST_UPGRADE` | — | 启动后自动跑一次升级流程到指定版本，用来验证接管页（填不存在的版本可走失败路径） |
| `DSH_MIN_TEST_UPGRADE_DELAY` | `6000` | 上面那个的延迟毫秒数 |

默认工作目录是当前用户的 `~/Documents/DSH`，也可以改 `main.js` 顶部的
`DEFAULT_WORKSPACE`，或用环境变量覆盖。

> ⚠️ 不要把它默认成 `process.cwd()`。实测 `npm start` 时壳的 cwd 是「这个壳项目自己的目录」，
> 那会建一个全新的空会话桶，网页端的历史会话一条都看不到；打包后双击启动时 cwd 更是指向别处。

## 开发

```bash
npm install          # 装 Electron + 自带运行时（.npmrc 已配国内镜像）
npm start            # 开发态运行
npm run pack         # 只打包成 .app（不压缩，快）
npm run dist:mac     # 出 DMG + ZIP
```

> `npm install` 会装四个运行时依赖：`@deepseek-ai/dsh`（引擎）、`node`（Node 二进制）、
> `npm`（升级引擎时要调它）和 `pnpm`（DSH 公开插件命令使用）。`node` 的二进制由它自己的 preinstall 下载，而我们用
> `--ignore-scripts` 装依赖，所以 `package.json` 里挂了个 `postinstall` 把它补回来 ——
> 少了这一步，打包出来的 App 会因为缺 node 而启动失败。

诊断工具（改样式之后用它自查，不用靠肉眼猜）：

```bash
./node_modules/.bin/electron diagnose.js   # 输出 diagnose-report.json
```

会启动一次真实窗口 + 后端，报告 DOM 真实层级、拖拽条位置与命中情况、侧栏留白是否生效等。

## 窗口拖拽（为什么默认拖不动、怎么修的）

`titleBarStyle: 'hidden'` 下 **Chromium 不会给内容区自动拖拽能力**。实测两面都验证过：
裸的 frameless 窗口里所有元素的 `-webkit-app-region` 计算值都是 `none`，dsh 自己也不设置。
而 dsh 的 UI 铺满整个窗口，没有现成的空白标题栏可以抓 —— 所以窗口完全拖不动。

修法：用 `executeJavaScript` 在页面里建一个**透明拖拽条**（照搬社区版验证过的模式）：

| 属性 | 值 | 理由 |
|---|---|---|
| `top` / `height` | `0` / `24px` | 落在红绿灯那一行的纵向范围，不压内容 |
| `left` | `80px` | 避开 macOS 红绿灯（横向约占 10~72） |
| `width` | `窗口宽 - 80 - 120` | 避开右侧头部按钮；窄窗口时自动收窄或隐藏 |
| 背景 | 透明 | 纯抓取区，不影响观感 |

**为什么不用 `insertCSS` 给侧栏设 drag**：dsh 的 DOM 里 `#root > div` 就是整个 frame，
`-webkit-app-region` 受层叠与指针事件影响，很容易误伤正文区（实测会让聊天内容变成 drag，
文字选不中）。自己创建的独立 div 行为最确定。

## 后端生命周期（两层收尸）

壳拉起 `dsh` 作为子进程，所以「壳结束了后端怎么办」必须处理干净，否则会留下占着端口的
孤儿后端（实测确实会发生）：

**第一层：优雅退出**（`before-quit`）
关窗不退出应用（macOS 习惯），后端继续跑、任务不中断。显式退出时发 `SIGTERM` 等它排空。
DSH 自己给了 5 秒排空宽限（`PROCESS_SHUTDOWN_TIMEOUT_MS = 5e3`），所以这里等 7 秒再升级到
`SIGKILL` —— 卡在 4 秒会把排空砍断、留下半截会话日志。

**第二层：看门狗**（`watchdog.js`）
壳可能被 `kill -9`、崩溃、或被系统强制结束，那时**任何信号处理器都不会运行**。所以启动时
另起一个独立进程（`detached + unref`），只轮询壳是否还活着，壳一消失就收尸，然后自己退出。

实测：`kill -9` 壳之后，后端在数秒内被清理，看门狗自身也干净退出。

## 一个会随时间恶化的故障：会话 cookie 累积 → HTTP 431

**症状**：App 用了几十次之后，某天突然打不开界面了 —— 窗口能出来、能看到 Harness 的报错页：

```
Failed to load plugins
failed to import loader entry …: client-modules:
bundle script /plugins/??@deepseek-ai/dsh-api-gateway/client.js,…&rev=5633dc036e77 failed to load
```

看起来像「dsh 升级把界面弄坏了」，其实是**这个壳自己攒出来的**。

### 成因

三件事叠在一起：

1. 后端用 `--port 0` 启动 → **每次都是一个新端口**
2. dsh 的浏览器会话 cookie 名字是 `dsh-auth-<base64url(sha256(host:port))>` → **端口进了哈希**
3. cookie 挂在 `127.0.0.1` 这个域下、30 天过期，**没有任何人会去删旧的**

于是每次启动都留下一条永久的新 cookie，而它们**全部**会被附带在之后每一个请求上。

实测攒到 **64 条（约 3.4KB）** 时，加上 `/plugins/??…` 那条把 50 多个客户端模块拼在一起的
**超长合并 URL**，整个请求头块越过了 Node 默认的 16KB 上限（`--max-http-header-size`），
服务端直接回：

```
HTTP 431 Request Header Fields Too Large
```

浏览器拿不到那个模块包 → 插件全加载不出来 → 就是上面那个报错页。

> 为什么难查：它**不是一开始就坏**。新装的机器、刚清过数据的机器一切正常，跑几十次之后才开始，
> 而且每次重启端口都不同，cookie 数量只增不减 —— 越用越坏，永不恢复。

### 修法

每次导航之前把 `dsh-auth-` 前缀的 cookie 全清掉（`pruneAuthCookies()`）：

```js
const all = await session.defaultSession.cookies.get({})
for (const c of all.filter((c) => c.name.startsWith('dsh-auth-'))) {
  await session.defaultSession.cookies.remove(`http://${c.domain}${c.path}`, c.name)
}
```

**为什么可以无脑全删**：启动时我们本来就是拿一枚**全新的、进程级的** token 去换 cookie
（token 存在 `PROCESS_LAUNCH_TOKENS` 这个 WeakMap 里，每次启动都不同），从来不依赖旧 cookie
存活。删完这次导航立刻重新种下当前端口那一条。

必须在**导航之前**完成 —— 放后面可能把即将种下的新 cookie 一起删掉。

实测：恢复 65 条历史 cookie 后启动，日志报 `清理了 65 条历史会话 cookie`，431 归零，
界面正常；连启 5 次，cookie 数稳定在 1 条以内。

<details>
<summary>排查过程（踩过的三个错误结论）</summary>

我先后得出过三个**错误**结论，都是被「能复现」骗了：

1. **以为接管页（splash）导致的。** 因为带 splash 的路径失败、不带 splash 的 attach 路径成功。
   错在两次对比用的**不是同一个引擎**（一个是 0.1.5-rc.1，一个是当时自带的 0.1.2-rc.1），
   而 0.1.2 的客户端模块包**更小**，正好卡在阈值以下 —— 变量没控制住。
   （自带引擎现在已经跟到 0.1.5-rc.1，两个包一样大，这种混淆不会再发生。）
2. **以为 0.1.5-rc.1 这个引擎坏了。** 用 attach 模式接上去也失败，看着很像引擎问题。
   但那次 attach 复用了**已经被兑换过的 token**，页面根本没正常加载。
3. **以为 main.js 里某个钩子导致的。** 写了个开关式对照实验，把窗口尺寸、无边框、
   `will-navigate`、`insertCSS`、拖拽区注入逐一打开 —— **六种组合全部正常**。

真正定位靠的是给 `webRequest.onCompleted` 挂一行日志，直接看到 **`431`**。
前面三次都是在**猜变量**，而这一次是让网络层自己说话。

教训：**对照实验里「失败」的那一侧，一定要确认它是真的按预期失败了**，
否则一个假失败会把你带到完全错误的方向上去。

</details>

## macOS 红绿灯

窗口用 `titleBarStyle: 'hidden'`，保留红绿灯、内容延伸到顶部。这需要给侧栏顶部留白，
否则 dsh 的品牌标会被压在红绿灯下面（实测：侧栏从 (0,0) 开始、品牌标在 y=27，而红绿灯约占 y=10~24）。

留白通过 **`insertCSS` 注入**完成，**不修改 dsh 任何文件**：

```css
#root > div > div:first-child > div:first-child {
  padding-top: 30px !important;
}
```

选择器刻意用**结构**而不是类名 —— dsh 的 CSS 类是构建期哈希的，并且**不同构建产物哈希不同**
（官方 npm 构建是 `hHd-Xa_root`，作者本地构建是 `IrIWsq_root`，版本号相同）。任何依赖类名的
样式都会随升级失效。

实测结果：

| 状态 | 侧栏宽度 | 顶部第一个按钮 | 是否让开红绿灯 |
|---|---|---|---|
| 展开 | 280px | 品牌标 y=57 | ✅ |
| 折叠 | 56px | 折叠按钮 y=48 | ✅ |

## 原生通知：一轮跑完提醒你

网页版最大的问题是「跑长任务时只能盯着标签页」。桌面壳补上了这个：**一轮对话结束时发一条系统通知，点一下回到窗口**。

整个功能**没有往 dsh 里塞任何插件**。

### 触发信号：读会话事件流，不碰内核

通知的触发点来自 dsh 自己写的会话日志：

```
$DSH_HOME/sessions/<编码后的 cwd>/<session-id>/session.jsonl.zstd
```

这是 zstd 分帧的追加式日志，每帧是一批事件（`turn/start`、`assistant/message`、`turn/end` …）。
`notify.js` 增量 tail 这个文件，只在 `turn/end` 时触发通知。

为什么选这条路：

- **零侵入**。不注册服务、不改配置、不装插件，dsh 升级不影响它。
- **它本来就是 dsh 的持久化真相源**，不是在猜 UI 状态。
- 会话投影缓存（`~/.dsh/storages/session_projcache/`）是**派生缓存**（`stateVersion` 会跳变），
  所以只用它取会话标题，绝不用它当触发信号 —— 缓存抖动不该变成通知抖动。

有三个坑值得记下来：

1. **zstd 截断不一定报错**。尤其带 checksum 的帧只缺最后 1～3 字节时，Node 仍可能
   返回完整明文。现在先解析帧头和 block 长度，确认 checksum 也完整，再解压该精确帧；
   明文以换行结尾作为第二道检查。启动监听时会回到最后一帧的起点，所以即使恰好撞上
   正在写入的半帧，写完后仍能正确消费。
2. **摘要只能取正文**。`assistant/message` 里可能同时有 `text` 和 `reasoning`，
   只取 `text`；纯工具调用的消息不能覆盖已有摘要，否则通知正文会变成一串函数名。
3. **新文件注册完必须立刻消费**。`sweep()` 发现新会话文件时只登记了「从 0 开始读」
   就 `continue` 了，消费要等下一轮轮询（3 秒）—— 表现是**新会话的第一轮通知平白
   迟到几秒**。改成登记完同一次就 `schedule()`，实测新文件 1.5 秒内必定投递。

### 通知长什么样

两段式，对齐微信那种观感：

| 位置 | 内容 |
|---|---|
| 标题 | 会话标题（谁在说） |
| 正文 | 助手回复的摘要（截断到 40 字） |

**刻意不显示「任务完成」和用时**。正常跑完是默认预期，把它写进通知是噪音；只有
「谁 + 说了什么」的通知信息密度最高。中断则相反 —— 它是异常路径，必须说出来：

| 这轮怎么结束的 | 标题 | 正文 |
|---|---|---|
| 正常完成 | 会话标题 | 回复摘要 |
| 正常完成，但这轮没有文字回复 | 会话标题 | `本轮没有文字回复` |
| 被中断（Esc 等） | 会话标题 | `任务中断` |

中断时**不显示那半截摘要**：一条既说「中断」又带半句回复的通知，容易让人误以为
这轮正常跑完了。

菜单里「显示会话标题」「显示回复摘要」都能单独关。关掉摘要就是一条只有标题的短通知，
像微信的「有一条新消息」；关掉标题则退回 App 名当标题。
（「显示会话标题」读的是投影缓存，读不到时同样退回 App 名，绝不因此不发通知。）

**默认窗口在前台也通知** —— 「跑完了」这件事本身就有信息量，不该因为你在看别的地方
就被吞掉；想要安静可以切到「仅窗口不在前台时」，或者用「仅长任务」按 30 秒阈值过滤。

### 菜单栏「通知」分块

和「引擎」「服务」并列的一级菜单。划分原则是**一级放开关和动作，二级放成组的选项**：

| 层级 | 项目 |
|---|---|
| 一级 | **启用通知**（总开关） |
| 一级 | **任务中断时也通知**（独立开关，不塞进「通知内容」里） |
| 二级 | **通知方式** ▸ `始终通知` / `仅窗口不在前台时` / `仅长任务（超过 30 秒）` |
| 二级 | **通知内容** ▸ `显示会话标题` / `显示回复摘要` |
| 一级 | **测试通知权限…**（动作） |
| 一级 | **最近投递**（只读状态） |

「测试通知」不是装饰：macOS 上 `Notification.isSupported()` 在**没授权时也返回 true**，
只有真的投递一次、看 `show` 还是 `failed` 事件才知道真相。

### 一个必须知道的坑：签名方式决定通知能不能发

打包时如果用的是 electron-builder 的默认签名（`identity: null`，即 linker-signed，
包的 `Identifier` 还是 `Electron`），通知**构造成功但投递失败**，报 `UNErrorDomain 错误 1`。

必须改成 ad-hoc 签名并带正确 bundle id：

```yaml
identity: '-'      # 而不是 null
```

改完之后 `show` 事件正常触发。另外，**开发模式（`electron .`）下通知永远发不出来** ——
这是 Electron 自身的限制，跟本项目无关。所以验证通知一定要跑打包后的 `.app`。

> 顺带一提：这里以前踩过一个更隐蔽的坑 —— 快捷回复功能里有个变量名笔误，
> 让 `notify()` 在 Promise 构造器里抛 `ReferenceError`，于是通知**彻底静默失效**：
> 没有日志、没有报错，就是不弹。现在 `notify()` 的整个构造过程包在 `try` 里，
> 任何异常都降级成一条可诊断的 `failed:...` 结果，不会再变成黑洞。

## 图标：纯白底板 + 纯黑官方鲸鱼

图标里的鲸鱼**不是自己描的，是从 dsh 官方包里取的**：

```
node_modules/@deepseek-ai/dsh-web-frontend/dist/favicon.svg
```

那是官方 Web UI 的 favicon，也是它 `manifest.webmanifest` 里唯一的图标条目 ——
即官方承认的品牌图形。生成脚本只做两件事：把它的 `<path>` 拿出来、填成黑色，
放上一个白色底板。**图形本身一笔不改。**

```bash
npm run icon                          # 默认：白底 + 黑鲸鱼，鲸鱼占底板宽 90%
npm run icon -- --fill 0.78           # 鲸鱼小一点
npm run icon -- --bg '#000' --fg '#fff'   # 反色：黑底白鲸鱼
npm run icon -- --tile 0              # 不画底板，只交图形给系统（见下）
```

### ⚠️ 底板是本脚本画的，不是官方素材

官方包里**只有鲸鱼那一条 path，没有任何底板/背景资源**（那个 SVG 里就一个
`<path>`，连 `<rect>` 都没有）。所以白色底板是合成的。

那能不能「不画底板，让 macOS 自己配背景」？**能，但系统给的是灰色，不是白色。**
实测（macOS 27 / Tahoe 内核，把只有黑鲸鱼的 icns 装进 App 启动后截 Dock）：

| 做法 | Dock 里实际显示 |
|---|---|
| 只交黑鲸鱼，透明背景 | macOS 自动套一个**浅灰**圆角底板（社区叫它 icon jail） |
| 自己画白色圆角底板 | macOS **原样保留白色**，不做任何替换 |

所以「纯白背景」和「交给 Mac 去做」不可兼得：系统的兜底底板是灰的。
要白色就必须自己画 —— 也就是 `--tile 0` 之外的那条路。顺便说，这个灰色兜底
也解释了为什么有些老旧 App 的图标在 Dock 里是灰方块。

### 换了图标之后，通知里可能还是旧图标

**这是 macOS 的图标缓存，不是 App 没更新。** 换图标后实测：Dock 立刻显示新图标，
但**通知横幅里还是旧图标**，而且杀掉 App、重启 Dock、`killall usernoted` 都不管用 ——
缓存是按 bundle id 存在图标服务里的，跟 App 进程无关。

要清掉它（`~/Library/Caches/com.apple.iconservices.store` 在新系统上已经不存在了，
真正的位置在 per-user 的 `DARWIN_USER_CACHE_DIR`）：

```bash
CACHE=$(getconf DARWIN_USER_CACHE_DIR)
rm -rf "$CACHE"com.apple.iconservices "$CACHE"com.apple.iconservicesagent
killall iconservicesagent Dock usernoted NotificationCenter
```

然后重开 App、再发一条通知即可。

**全新安装的用户不会遇到这个问题** —— 没有旧图标可缓存。只有从旧版本升级上来、
且系统恰好缓存过老图标时才会看到。

### 底板形状：不是普通圆角矩形

实测系统图标（Finder / Preview / Notes / Calculator 的 `.icns`，取 alpha≥128
也就是 50% 覆盖率的真实几何边界）：

| 项 | 实测值 |
|---|---|
| 主体 | 824×824，位于 1024 画布正中 (100,100)，占画布 80.5% |
| 角 | **不是圆弧** —— 角沿边延伸 209px，顶边平坦段只剩 406px |

半径 184.3 的普通圆角矩形平坦段是 455px，比系统图标「方」一圈。这里改用超椭圆
拟合实测轮廓，角盒 `E = 0.2536 × 边长`、指数 `n = 2.31`：

```
x(y) = E * (1 - (1 - ((E-y)/E)^n)^(1/n))
```

与实测角轮廓逐点吻合（dy=20 算得 103.6 / 实测 102；dy=80 算得 31.6 / 实测 32；
dy=120 算得 13.3 / 实测 13）。**和 Finder 的真实轮廓比对：IoU 99.82%，
bbox 完全一致。**

> 拟合时先按「整条半边长」当角盒，怎么都拟合不上 —— 因为真正的角盒只有 209px，
> 不是 410px。把角盒当成未知量一起解，指数才收敛到 2.31。

### 为什么必须借 Chromium 渲染

那个 path 有 **4 个子路径且互相嵌套**（鲸鱼身体 / 鳍 / 两只眼睛），靠
`fill-rule="nonzero"` 的环绕方向挖空。用 PIL 的 `polygon` 或任何按「简单多边形」
处理的库都画不出那些挖空 —— 会得到一只实心的黑鱼。Chromium 是唯一现成的、
能正确处理它的渲染器，而 Electron 里就自带一个，所以脚本会**用 electron 把自己重新拉起**。

顺带一提：官方 SVG 里有一段

```css
@media (prefers-color-scheme: dark) { path { fill: #fff; } }
```

系统是深色模式时直接渲染会得到**白鲸鱼**（拿 QuickLook 预览就是一片空白）。
所以脚本只取它的 path 数据，颜色由自己显式指定，不受媒体查询影响。

### 渲染与自检

| 项 | 值 |
|---|---|
| 画布 | 1024×1024 |
| 底板 | 824×824 @ (100,100) |
| 渲染分辨率 | 2048（2 倍超采样，再缩到各档）|

底板之外**必须透明** —— 系统不会替 App 裁形状。脚本结尾会自检四角透明、
底板外透明、中心像素是 `--fg` 色。

<details>
<summary>踩过的两个坑：自检自己写错了 + 自交路径</summary>

**一、自检报「底板外透明 ❌」，其实是自检写错了。**
取样点取成 `tile / 2`（=412），而底板是从 x=100 开始的，412 落在底板**内部**，
量到的当然是不透明。正确取样点在左侧留白的中间，即 `(画布 - 底板) / 4`。
教训：**自检失败时先怀疑自检**，否则会把一个本来就对的图标改坏。

**二、四个角用同一条曲线镜像时，遍历方向必须一致。**
第一版右下角方向反了，路径自交，nonzero 填充结果往外鼓出一个三角形。
更阴的是我「修」这个 bug 时又改错了 `M` 的起点，变成左上角也鼓一个 —— 两个一起
出现才看出来。判定方法不能靠肉眼：把渲染结果的 alpha 轮廓和 Finder 的真实轮廓
做 IoU，修好后是 99.82%，残差 1117px 全在四条直边上（每行最多 28px），
是边缘抗锯齿的阈值差异，不是形状错误。

</details>

## 文件

| 文件 | 作用 |
|---|---|
| `main.js` | 壳逻辑 + 「引擎」「通知」菜单：初始化、起窗口、解析引擎、拉后端、注入样式、生命周期 |
| `updater.js` | 引擎升级器：检测、安装、关卡、提升、回滚 |
| `plugin-installer.js` | 初始化插件白名单、DSH CLI 调用、配置验证与失败恢复 |
| `setup.html` | 首次安装 / 覆盖重装时显示的可选插件初始化页 |
| `notify.js` | 会话日志 tail + 轮次结束解析（zstd 分帧解码、摘要提取） |
| `splash.html` | 接管页：下载 / 校验 / 重启引擎期间窗口里显示的就是它 |
| `watchdog.js` | 独立看门狗进程，壳异常结束时收尸 |
| `output-lines.js` | 把任意分块的后端输出还原成完整行，避免漏读或截断启动 token |
| `diagnose.js` | 布局与拖拽区域的诊断工具 |
| `tools/make-icon.js` | 从官方 favicon 生成 `build/icon.icns`（借 Electron 的 Chromium 渲染） |
| `build/icon.icns` / `icon.png` / `icon.svg` | 图标成品与留档 |
| `electron-builder.yml` | 打包配置（含关闭 asar、ad-hoc 签名的原因） |
| `.npmrc` | Electron 二进制走国内镜像 |

## 已知边界

- **未做代码签名/公证**。首次打开需要右键→打开，或清一次隔离属性。
  （但**签名方式必须是 ad-hoc**，否则系统通知发不出来，见上文。）
- **通知需要系统授权**。第一次弹通知时 macOS 会问；如果被拒了，去「系统设置 → 通知」里打开。
  菜单里的「测试通知」能立刻告诉你当前是通的还是被拦的。
- **开发模式（`electron .`）下通知发不出来**，这是 Electron 自身的限制，验证请用打包后的 `.app`。
- **只支持 macOS arm64**。其它平台改 `electron-builder.yml` 的 target 理论上可行，但没验证过。
- **`--port 0` 会每次留一条 cookie**，靠启动时清理兜住（见「会话 cookie 累积 → HTTP 431」）。想彻底根治得改成固定端口。
- **单写者约束**：见上文，不要同时跑两个后端。
- **初始化选装首版只有两个白名单项**，完成向导后不在菜单中提供插件管理入口。
- **升级需要联网**，走 npm 的 registry（读你的 `~/.npmrc`，所以配了镜像就自动走镜像）。
- **引擎只保留「当前 + 上一个」**：能回滚的只有一步，再早的留着纯占磁盘（**一个约 280MB**），
  所以每次切换完和每次启动都会自动清掉更旧的。菜单里不再需要「删除旧引擎」。
- **升级不覆盖自带引擎**。App 里那份永远是打包当天的版本，是最后兜底；`engines/` 删光也能启动。

## 许可

MIT。核心能力来自 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)。
本项目是社区项目，非 DeepSeek 官方发行版。
