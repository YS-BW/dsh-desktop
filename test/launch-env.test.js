'use strict'

/**
 * 「从 Finder / Dock 双击启动」这条路径的回归测试。
 *
 * 为什么单独一个文件：main.js 是单例式的（模块级状态 + 单实例锁），
 * 而 main-boot.test.js 里的桩默认让启动链停在「找不到引擎」，`backendEnv()`
 * 一次都不会执行。要覆盖它就必须**让引擎解析成功**，把启动链再往前推一格。
 *
 * 背景（这是一个真实事故）：
 *
 *   f0255c8 那次把 backendEnv() 里的 `env.PATH = fromShell` 重构成了
 *   `setEnvPath(env, fromShell)`，但忘了把它加进 main.js 顶部从 ./platform
 *   解构的名单。于是 backendEnv() 抛 ReferenceError，后端根本起不来。
 *
 *   更阴的是触发条件：needsShellPath() 只在 PATH「像是 launchd 给的」时返回 true ——
 *   也就是**从 Finder/Dock 双击启动**时。在终端里跑（PATH 含 .hermes / homebrew
 *   这些用户级目录）时它是 false，这条分支根本不执行，所以开发时怎么测都是好的。
 *   双击启动恰恰是安装版最主要的用法。
 *
 * 所以这里显式把 PATH 换成 launchd 的最小形态，把那条分支逼出来。
 */

const assert = require('node:assert/strict')
const test = require('node:test')

const { bootMain } = require('./helpers/electron-stub')

const isWindows = process.platform === 'win32'

test(
  '从 Finder 启动时（launchd 最小 PATH）后端环境也能构建出来',
  { skip: isWindows ? 'launchd 最小 PATH 是 macOS 特有的；Windows 从注册表展开环境' : false },
  async () => {
    // /bin/echo 一定存在且立刻退出：引擎解析会成功，于是 startBackend() 真的
    // 走到 spawn —— 而 backendEnv() 在 spawn 之前就会被调用。echo 退出后
    // main.js 会走「后端已退出 → 报错对话框 + quit」，正好是桩的默认终止条件。
    const booted = await bootMain({
      overrides: {
        DSH_MIN_BIN: '/bin/echo',
        // launchd 给双击启动的进程就是这个：有 /usr/bin，没有任何用户级目录标记。
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin'
      }
    })
    try {
      assert.equal(
        booted.settled,
        true,
        '启动链应该走到终点。没走到说明 backendEnv() 抛了异常 —— ' +
          '最典型的就是 setEnvPath 之类的名字用了却没从 ./platform 导入'
      )
      // 关键在 detail 上，不在 message 上。
      //
      // backendEnv() 抛异常时会被 startBackend() 捕获、包装成 {ok:false,error}，
      // 最终同样弹一个 message 为「启动 dsh 失败」的框 —— 所以只断言 message
      // 是**没有判别力的**，这个 bug 会溜过去。两种情况下 detail 完全不同：
      //
      //   有 bug  → "setEnvPath is not defined"          （ReferenceError 被包了一层）
      //   正常    → "dsh 在就绪前退出（code=0 …）：web …" （进程真的跑起来了）
      //
      // 所以这里断言 detail 是后者，并且明确排除「is not defined」这一类。
      assert.equal(booted.calls.errorBoxes.length, 1)
      assert.equal(booted.calls.errorBoxes[0].message, '启动 dsh 失败')

      const detail = String(booted.calls.errorBoxes[0].detail ?? '')
      assert.doesNotMatch(
        detail,
        /is not defined|is not a function/,
        `构造后端环境时抛异常了，这属于「用了却没导入/未定义」：${detail}`
      )
      assert.match(
        detail,
        /在就绪前退出/,
        `应该走到「后端被真的拉起来、但没报出启动 URL」这一步，实际是：${detail}`
      )
      assert.equal(booted.calls.quit, true)
    } finally {
      await booted.cleanup()
    }
  }
)
