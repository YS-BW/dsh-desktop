# 开发与配置

环境变量、本地开发、诊断开关和文件清单。

---

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

默认工作目录是系统登记的“文档”目录下的 `DSH`：macOS 通常为
`~/Documents/DSH`，Windows 会自动适配 `%USERPROFILE%\\Documents\\DSH` 或 OneDrive
重定向后的文档目录。也可以用环境变量覆盖。

> ⚠️ 不要把它默认成 `process.cwd()`。实测 `npm start` 时壳的 cwd 是「这个壳项目自己的目录」，
> 那会建一个全新的空会话桶，网页端的历史会话一条都看不到；打包后双击启动时 cwd 更是指向别处。

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
