# 引擎与升级

引擎从哪来、怎么从 npm 升级、保留几个版本，以及一个会随时间恶化的 cookie 故障。

---

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

