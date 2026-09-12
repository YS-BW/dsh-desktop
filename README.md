# dsh-desktop-min

把**官方** DeepSeek Harness Web UI 装进一个原生 macOS 窗口 —— **零补丁、零插件**。

## 它是什么

一个约 340 行的 Electron 壳。它不重新实现任何界面，也不修改 dsh 的任何文件：
窗口里加载的就是 `dsh web` 提供的那个官方 Web UI，和你浏览器里看到的是同一套前端。

```
Electron 壳  ──spawn──>  dsh web --no-open --host 127.0.0.1 --port 0
     │                        │
     │  ← 读 stdout 拿到 URL ←  └─ 打印 "dsh web: http://127.0.0.1:PORT/?token=..."
     └─ 把那个 URL 加载进窗口
```

壳与 dsh 之间只有**三个公开约定**：

| 约定 | 内容 |
|---|---|
| 命令行 | `dsh web --no-open --host 127.0.0.1 --port <n>` |
| 环境变量 | `DSH_HOME`（数据目录）、进程 cwd（工作目录） |
| stdout | 启动时那一行 `dsh web: <带 token 的 URL>` |

因为只依赖这些，**dsh 官方怎么升级都不会破坏这个壳**——升级 DSH 就是换一个已安装版本，壳不用动。

## 运行

```bash
npm install          # 首次：装 Electron（.npmrc 已配国内镜像）
npm start
```

## 配置（环境变量，都有默认值）

| 变量 | 默认 | 作用 |
|---|---|---|
| `DSH_MIN_HOME` | `~/.dsh` | DSH 数据目录。默认与命令行 `dsh` **完全共用**，所以会话、配置、凭据互通 |
| `DSH_MIN_WORKSPACE` | 见下 | 工作目录。DSH 按 cwd 给会话分桶，必须与你网页端启动 dsh 时的目录一致 |
| `DSH_MIN_BIN` | 从 PATH 找 `dsh` | 指定 dsh 可执行文件 |
| `DSH_MIN_TOP_PAD` | `30` | macOS 红绿灯顶部留白（像素），嫌挤或嫌空可以调 |
| `DSH_MIN_ATTACH` | — | 接入一个已在运行的实例（需要它带 token 的启动 URL） |

**关于工作目录**（最容易踩的坑）：DSH 用 `$DSH_HOME/sessions/<编码后的 cwd>/` 给会话分桶，
所以「看到哪些会话」由这个路径决定，而不是由 `DSH_HOME` 单独决定。

默认值写在 `main.js` 顶部的 `DEFAULT_WORKSPACE` 常量里 —— **改它，或者用环境变量覆盖**。

> ⚠️ 不要把它默认成 `process.cwd()`。实测 `npm start` 时壳的 cwd 是「这个壳项目自己的目录」，
> 那会建一个全新的空会话桶，网页端的历史会话一条都看不到；打包成 `.app` 双击启动时 cwd 更是指向别处。

## 为什么不需要社区版那一堆补丁和插件

社区版（DSH Desktop）有 **22 个补丁 + 5 个桌面插件**，其中最关键的一个是
`dsh-desktop-hmr-fallback`。它存在的**唯一原因**是：Electron 把 dsh 跑在内置 Node 的
utility process 里时，`--expose-internals` 进不了 Node 的选项解析器，导致 Cordis 的 HMR
服务构造失败（`--expose-internals is required for HMR service`）。而 web profile 默认
`patchReload: "live"`，于是整个 profile 启动失败。

**本项目用真正的 Node 二进制跑 dsh**，`--expose-internals` 正常生效，官方 HMR 直接可用。
所以：零插件、零补丁。实测启动日志干净，没有任何降级警告。

## 窗口拖拽（为什么默认拖不动、怎么修的）

`titleBarStyle: 'hidden'` 下**Chromium 不会给内容区自动拖拽能力**。实测两面都验证过：

- 裸的 frameless 窗口里，`html` / `body` / 任意元素的计算值全是 `-webkit-app-region: none`
- dsh 自己也不设置任何拖拽区域

而 dsh 的 UI 铺满整个窗口，没有现成的空白标题栏可以抓 —— 所以**窗口完全拖不动**。

修法（照搬社区版 DSH Desktop 验证过的模式）：用 `executeJavaScript` 在页面里建一个**透明拖拽条**，
设 `-webkit-app-region: drag`：

| 属性 | 值 | 理由 |
|---|---|---|
| `top` / `height` | `0` / `24px` | 正好落在红绿灯那一行的纵向范围，不压任何内容 |
| `left` | `80px` | 避开 macOS 红绿灯（横向约占 10~72） |
| `width` | `窗口宽 - 80 - 120` | 避开右侧头部按钮；窄窗口时自动收窄或隐藏 |
| 背景 | 透明 | 纯抓取区，不影响观感 |

**为什么不用 CSS 的 `insertCSS` 给侧栏设 drag**：dsh 的 DOM 层级里 `#root > div` 就是整个
frame，而 `-webkit-app-region` 的命中范围受层叠与指针事件影响，很容易误伤正文区（实测会让
聊天内容也变成 drag，导致文字选不中）。单独一个自己创建的 div 行为最确定。

实测拖拽条：`rect = {x:80, y:0, w:1080, h:24}`、`app-region = drag`、
`elementFromPoint(中心) = 拖拽条自己`（说明没被任何元素盖住）。

> 注：窗口是否真的被拖动**无法用程序验证** —— Chromium 要求真实的 OS 鼠标按下，
> CDP 的 `Input.dispatchMouseEvent` 和 Electron 的 `sendInputEvent` 都试过，都返回
> `moved = false`。所以这一步只能靠手动确认。

## 诊断工具

```bash
./node_modules/.bin/electron diagnose.js   # 输出 diagnose-report.json
```

会启动一次真实的窗口 + 后端，然后报告：DOM 真实层级、拖拽条的位置与命中情况、
侧栏留白是否生效、品牌标坐标。改样式之后用它快速自查，不用靠肉眼猜。

## 后端生命周期（两层收尸）

这个壳拉起 `dsh web` 作为子进程，所以「壳结束了后端怎么办」必须处理干净 —— 否则会留下占着
端口的孤儿后端（实测确实会发生）。这里有**两层**保障：

**第一层：优雅退出（`before-quit`）**
关窗不退出应用（macOS 习惯），后端继续跑、任务不中断。只有显式退出时才对后端发 `SIGTERM`，
等它排空。DSH 自己给了 5 秒排空宽限（`PROCESS_SHUTDOWN_TIMEOUT_MS = 5e3`），所以这里等 7 秒
再升级到 `SIGKILL` —— 卡在 4 秒会把排空砍断、留下半截会话日志。

**第二层：看门狗（`watchdog.js`）**
壳可能被 `kill -9`、崩溃、或被系统强制结束，那时**任何信号处理器都不会运行**。所以启动时另起
一个独立的 `watchdog.js`（`detached + unref`，脱离壳的进程组），它只做一件事：轮询壳是否还
活着，壳一消失就对后端 `SIGTERM` → 7 秒后 `SIGKILL`，然后自己退出。

实测：`kill -9` 壳之后，后端在数秒内被清理，看门狗自身也干净退出。

## macOS 红绿灯

窗口用 `titleBarStyle: 'hidden'`，保留红绿灯、内容延伸到顶部。这需要给侧栏顶部留白，
否则 dsh 的品牌标会被压在红绿灯下面（实测：侧栏从 (0,0) 开始，品牌标在 y=27，而红绿灯约占
y=10~24）。

留白通过 **Electron 的 `insertCSS` 注入**完成，**不修改 dsh 任何文件**：

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

> 社区版还给折叠态加了宽度（56→80），实测**没有必要** —— 30px 留白已经把按钮推到 y=48，
> 红绿灯只占 y≈10~24。所以这里没有那条规则。

## 文件

| 文件 | 作用 |
|---|---|
| `main.js` | 全部壳逻辑：起窗口、拉后端、解析 URL、注入红绿灯留白、生命周期 |
| `watchdog.js` | 独立看门狗进程，壳异常结束时收尸 |
| `.npmrc` | 把 Electron 二进制指向国内镜像（本机直连 GitHub releases 不通） |

## 已知边界

- **单写者约束**：DSH 的 workspace 索引（`$DSH_HOME/storages/workspace.json`）是 home 级单文件，
  两个实例同时写会让会话掉进 Ungrouped（上游 [discussion #1485](https://github.com/deepseek-ai/deepseek-harness/discussions/1485)）。
  所以**不要同时开着这个窗口和在终端里跑的 `dsh web`**。
- **不带内置 Node**：目前复用系统已安装的 `dsh`。要打成完全自包含的 `.app`，
  需要额外把 Node 运行时（约 117MB）和 `@deepseek-ai/dsh` 打进包，并用 `ELECTRON_RUN_AS_NODE=1`
  或直接调 node 二进制启动。
- **UI 里装不了第三方插件**：那需要社区版的 `market-installer` 插件。可用命令行 `dsh plugin add` 代替。
