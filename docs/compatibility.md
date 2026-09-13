# 兼容性与边界

和社区同类项目的取舍差异，以及本项目已知的限制。

---

叫 `dsh-desktop` 的项目有好几个（`anywhere-labs`、`dataelement` 等，star 都比这里多得多）。
撇开体量，真正的分歧只有一条：**怎么对待上游**。

**社区主流做法是 vendor + 打补丁。** 以 `dataelement/dsh-desktop` 为例，它把整份 Harness
以 tarball 形式放进仓库，用 `file:` 引用一百多个包：

```jsonc
"@deepseek-ai/dsh": "file:packages/harness-0.1.2-rc.1/npm-dsh/deepseek-ai-dsh-0.1.2-rc.1.tgz"
"dsh-desktop-client-ui":    "file:packages/dsh-desktop-client-ui"     // 自己的 UI 插件
"dsh-desktop-hmr-fallback": "file:packages/dsh-desktop-hmr-fallback"  // 顶替 HMR 的补丁包
```

它文档目录里有 `harness-0.1.2-upgrade.md`、`…alpha.3…`、`…alpha.4…`、`…rc.1…`
**四份上游迁移文档** —— 这就是这条路的价格：上游每动一次，都要跟一次。

**这个项目只依赖公开约定**（`web` 子命令及其 `--patch` 组合接口、`DSH_HOME` 环境变量、stdout 那行 URL），
所以引擎能直接从 npm 升，不用重发 App：

| | 本项目 | 社区 vendor 路线 |
|---|---|---|
| 上游依赖 | 普通 npm 依赖，跟随 latest | vendor 进仓库 + patch layer |
| Harness 进程 | **自带真 node 二进制** | Electron UtilityProcess（需 `hmr-fallback` 顶替 HMR）|
| 数据目录 | **默认 `~/.dsh`，与命令行 dsh 共用** | App 私有 `userData/harness/` |
| 引擎更新 | 运行时从 npm 拉，3 道关卡验证，可回滚 | 整包自动更新 |
| 平台 / 签名 | macOS arm64，ad-hoc（未公证）| macOS + Windows，Apple 公证 |
| 额外功能 | 原生通知、菜单栏升级、升级接管页、选装插件 | 手机配对、PPT 生成、预设包、Safe Mode、插件市场 |

### 为什么这条路上不需要 `hmr-fallback`

Electron 的 utility process 里，`--expose-internals` 能进 `execArgv`，却**进不了 Node 的
选项解析器**，于是 `ctx.loader.internal` 缺失，Cordis 的 HMR 服务构造函数直接抛异常 ——
把整个 profile 启动一起带崩。社区为此写了一个假的 `hmr` 服务顶上去，真 HMR 只能放弃。

本项目的做法是**在 App 里带一个真正的 node 二进制**，用 `node <bin.js>` 启动而不是借
Electron 的 utility process。这条路根本不存在，所以一个补丁包都不需要。

**取舍是明确的**：这边功能面窄得多，也没有公证；换来的是上游怎么升都不痛。

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
