# dsh-desktop

把**官方** DeepSeek Harness Web UI 装进一个原生 macOS 窗口 —— **零补丁、零插件**。

> A minimal Electron shell for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
> It ships the stock web UI in a native window with **zero patches and zero plugins**, and shares
> sessions/config with the official `dsh` CLI. Engine updates come straight from npm, so upgrading
> DSH never requires rebuilding the app.

---

## 它是什么

一个约 640 行的 Electron 壳。它**不重新实现任何界面**，也**不修改 dsh 的任何文件**：
窗口里加载的就是 `dsh web` 提供的那个官方 Web UI，和你浏览器里看到的是同一套前端。

```
Electron 壳  ──spawn──>  node <dsh>/lib/bin.js web --no-open --host 127.0.0.1 --port 0
     │                              │
     │  ← 读 stdout 拿到 URL ← ──────┘  打印 "dsh web: http://127.0.0.1:PORT/?token=..."
     └─ 把那个 URL 加载进窗口
```

壳与 dsh 之间只有**三个公开约定**：

| 约定 | 内容 |
|---|---|
| 命令行 | `web --no-open --host 127.0.0.1 --port <n>` |
| 环境变量 | `DSH_HOME`（数据目录）、进程 cwd（工作目录） |
| stdout | 启动时那一行 `dsh web: <带 token 的 URL>` |

因为只依赖这些，**dsh 官方怎么升级都不会破坏这个壳**。

## 安装

从 [Releases](../../releases) 下载 DMG，拖进「应用程序」即可。App **自带引擎**，
所以下载后不需要预装 Node.js 或 dsh。

> **首次打开**：包没有做代码签名与公证，macOS 会拦住。任选其一：
> - 右键点 App → **打开** → 再点「打开」
> - 或执行一次：`xattr -dr com.apple.quarantine "/Applications/DSH Desktop Min.app"`

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
  自带引擎：0.1.2-rc.1              （只读）
  已安装：0.1.5-rc.1
  ─────────────
  检查更新…                    ⌘U
  升级到 0.1.5-rc.2                  ← 检测到新版才出现
  ─────────────
  回滚到 0.1.2-rc.1（自带）           ← 有上一个版本才出现
  切换到已装版本 ▸
  删除旧引擎 ▸
  ─────────────
  改用 App 自带引擎
```

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
⑤ 重启    询问后重启后端（约 2 秒不可用）
```

**升级期间 dsh 一直可用**（安装约 1 分钟、关卡约 5 秒），只有第 ⑤ 步重启那 2 秒不可用。

**关卡不通过就什么都不改**：删掉 staging，继续用原来的引擎。

### 两条铁律

**一、版本化目录，绝不碰正在运行的那份。**

dsh 运行时会用 `await import()` 延迟加载模块（装插件、profile 热重载都会触发）。如果升级去动它脚下的文件，那些 import 会失败，或者加载到新旧混合的状态。所以新版本装到 `engines/<新版本>/`，正在跑的那份全程只读，切换只改 `current` 这个指针文件。

**二、升级由外壳驱动，不是 dsh 插件。**

dsh 插件活在**要被替换的那个进程**里，让它编排自己的替换等于进程自杀式自我更新。外壳在 dsh 外面，才能干净地停后端、换指针、重启。

### 回滚

「上一个版本」记的是**具体版本号**，不是「自带」这种抽象状态：

- 升级前用的是自带引擎 → `previous` 记的是自带引擎的版本号（如 `0.1.2-rc.1`），
  菜单显示「回滚到 0.1.2-rc.1（自带）」，回滚即清掉指针
- 升级前用的是某个已装引擎 → 菜单显示「回滚到 0.1.5-rc.1」，回滚即切指针过去

回滚是**交换语义**（滚回去之后，刚才那个版本变成新的「上一个版本」），所以误操作可以再滚回来。

回滚**只改指针，不动任何已安装的文件**，所以不会丢东西。

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
| `DSH_MIN_DESKTOP_HOME` | `~/.dsh-desktop` | 本 App 自己的数据根目录（目前只放从 npm 更新的引擎） |
| `DSH_MIN_BIN` | 自动解析 | 直接指定 dsh 入口，跳过引擎解析链 |
| `DSH_MIN_TOP_PAD` | `30` | macOS 红绿灯顶部留白（像素），嫌挤或嫌空可以调 |
| `DSH_MIN_ATTACH` | — | 接入一个已在运行的实例（需要它带 token 的启动 URL） |

默认工作目录写在 `main.js` 顶部的 `DEFAULT_WORKSPACE` 常量里，**改它或用环境变量覆盖**。

> ⚠️ 不要把它默认成 `process.cwd()`。实测 `npm start` 时壳的 cwd 是「这个壳项目自己的目录」，
> 那会建一个全新的空会话桶，网页端的历史会话一条都看不到；打包后双击启动时 cwd 更是指向别处。

## 开发

```bash
npm install          # 装 Electron + 自带运行时（.npmrc 已配国内镜像）
npm start            # 开发态运行
npm run pack         # 只打包成 .app（不压缩，快）
npm run dist:mac     # 出 DMG + ZIP
```

> `npm install` 会装三个运行时依赖：`@deepseek-ai/dsh`（引擎）、`node`（Node 二进制）、
> `npm`（升级引擎时要调它）。`node` 的二进制由它自己的 preinstall 下载，而我们用
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

## 文件

| 文件 | 作用 |
|---|---|
| `main.js` | 壳逻辑 + 「引擎」菜单：起窗口、解析引擎、拉后端、注入样式、生命周期 |
| `updater.js` | 引擎升级器：检测、安装、关卡、提升、回滚 |
| `watchdog.js` | 独立看门狗进程，壳异常结束时收尸 |
| `diagnose.js` | 布局与拖拽区域的诊断工具 |
| `electron-builder.yml` | 打包配置（含关闭 asar 的原因） |
| `.npmrc` | Electron 二进制走国内镜像 |

## 已知边界

- **未做代码签名/公证**。首次打开需要右键→打开，或清一次隔离属性。
- **只支持 macOS arm64**。其它平台改 `electron-builder.yml` 的 target 理论上可行，但没验证过。
- **单写者约束**：见上文，不要同时跑两个后端。
- **不自带第三方插件市场**。要装社区插件用命令行的 `dsh plugin add`。
- **升级需要联网**，走 npm 的 registry（读你的 `~/.npmrc`，所以配了镜像就自动走镜像）。
- **每个引擎版本约 200MB**。默认保留「当前 + 上一个」用于回滚；菜单里可以删旧版本。
- **升级不覆盖自带引擎**。App 里那份永远是打包当天的版本，是最后兜底；`engines/` 删光也能启动。

## 许可

MIT。核心能力来自 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)。
本项目是社区项目，非 DeepSeek 官方发行版。
