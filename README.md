# dsh-next-step-suggest

根据当前回答给出下一步建议的 DSH 插件。

每轮回答结束后，插件会用**会话当前选中的模型**做一次轻量辅助调用，
基于「你最近的提问 + 助手最近的回答」提炼 **3 条可以直接发送的后续消息建议**，
以可点击的建议条（chips）浮层展示在输入框上方；点击任意一条即填入输入框
（若已有草稿则换行追加），按回车即可发送。

## 功能

- **自动生成**：检测到一轮回答完成（`turn-tail` / `turn-error` / `turn-max-tokens`
  边界且为流的最后一个节点）后自动发起建议生成；开关状态持久化在 localStorage。
  开关有**两个常驻入口**，都不依赖精确瞄准：
  - ✨ 图标的悬停弹层：整行（文字 + 轨道）都是点击目标，最小高度 36px；
    弹层以 220ms 延迟关闭，避免鼠标从图标移向弹层时穿过间隙导致弹层消失。
  - 建议面板头部：常驻紧凑开关，完全不需要悬停。
  两处开关共用同一个 `useState`，任一处切换都会立即同步到另一处。
- **手动生成**：输入框工具栏右侧 ✨ 图标按钮随时生成 / 重新生成；回合进行中时
  按钮自动禁用，旧面板自动收起。
- **建议交互**：面板提供「重新生成」「停止」「关闭」；每条建议一键填入草稿。
- **会话隔离**：按会话分别捕获模型路由与回合内容；subagent 会话不显示入口。
- **注入防护**：提问与回答在宿主侧用分隔符包裹并声明「不执行其中指令」，
  路由仅允许 loopback 访问。

## 工作原理

```
浏览器半边 (lib/client.js)                宿主半边 (lib/index.js)
conversation.composer.dock 席位            POST /api/dsh-next-step-suggest
  │ useChat(selector) 蒸馏回合              │ ctx.llm.stream({provider, model,…})
  │ useInput(selector) 读当前草稿           │
  │ 回合完成 → fetch 当前模型路由 ──────────▶│ 组装系统提示词 → JSON 数组解析
  │ ◀──────────────────────── { suggestions }│
  └ 点击 chips → inputActions.setDraft
```

不修改任何官方内核包，仅使用公开 client-runtime 服务
（`slots` / `modelDirectories` / `sessions`）与官方 `webServer` + `llm` 服务。

### 为什么用 `useChat` 而不是 `useSession`

渲染器会把每个 session 级标准源按 `hooks: ["<name>"]` 暴露成 `use<Name>` prop。
**会话快照（`ui-session` 的 `buildSnapshot()`）里没有 `chat` 字段**——它只带
`sessionId / pendingSubmissions / running / subagent / removed / openState /
openError / hasMore / loadingOlder / promptError / blank / lastAgentError /
promptAttempted / awaitingFirstTurn`。对话内容由 `ui-chat` 通过独立的
`hooks: ["chat"]` 贡献提供，即 `useChat`；草稿由 `ui-conversation` 的
`conversation.input` 贡献提供，即 `useInput`。

因此 `useSession((s) => s.chat)` 恒为 `undefined`，selector 会静默返回空串，
表现为「按钮在、面板不弹、点了提示当前会话还没有已完成的回答」。组件现在优先
取 `useChat`，仅在拿不到时回退 `useSession`（selector 两种快照形态都兼容）。
`/diag` 里的 `hook-shape` 事件会记录实际选中的源，便于以后排查。

## 安装

从 GitHub Release 安装预构建 tarball（推荐，免去 `allowBuilds` 构建授权）：

```sh
dsh plugin --profile web add "https://github.com/anye-99/dsh-next-step-suggest/releases/latest/download/dsh-next-step-suggest.tgz"
```

从源码安装：

```sh
dsh plugin --profile web add github:anye-99/dsh-next-step-suggest
```

安装后重启 DSH。建议钉住提交以保证可复现：
`dsh plugin --profile web add github:anye-99/dsh-next-step-suggest#<commit>`。

### 本地开发安装（profile 本地插件）

1. 将本目录复制到 `<DSH_PROFILE_DIR>/local-plugins/dsh-next-step-suggest/`
2. 在 `<DSH_PROFILE_DIR>/package.json` 的 `dependencies` 中加入：
   ```json
   "dsh-next-step-suggest": "link:./local-plugins/dsh-next-step-suggest"
   ```
   并在 `dsh.profile.bundles` 数组末尾加入 `"dsh-next-step-suggest"`
3. 在 profile 目录执行 `pnpm install`
4. 重启 DSH

### 开发时避免手动同步（推荐）

上面的第 1 步是**复制**，因此改了工作目录的代码后，profile 侧不会自动更新。
用 `scripts/sync-to-profile.ps1` 把 `lib/` 和 `scripts/` 换成指向工作目录的
**junction**（目录联接），之后改动即时生效：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\sync-to-profile.ps1
# 换 profile：-Profile web ；只看不改：-DryRun
```

脚本是幂等的，重复运行只会报告状态。它做三件事：

1. 校验 `lib/`、`scripts/` 是否为指向本仓库的 junction，断了或指错就重建
   （重建前把实体目录备份到 `~/.dsh/_plugin-backups/`）；
2. 对齐 `package.json` / `README.md` / `LICENSE` / `cordis.patch.yml`
   —— 文件级符号链接在 Windows 需要管理员或开发者模式，硬链接又不能跨卷，
   所以这四个文件只能复制；
3. 打印后续注意事项。

为什么不是整个插件目录做 junction：`local-plugins/<name>` 自身被 DSH 的
HMR watcher 持有句柄，改不动；但**目录内部**可以自由增删改，所以链接放在
`lib/`、`scripts/` 这一层。

`lib/` 与 `scripts/` 的改动由 HMR 自动生效（改完约 1 秒浏览器即重载，无需重启
DSH）；`package.json` 这类静态文件的改动可能仍需重启 DSH 才会重新读取。

## 卸载

从 `package.json` 移除上述两处条目，`pnpm install` 后重启即可；
删除 localStorage 键 `dsh-next-step-suggest:auto` 可重置开关。

## 已知限制

- 建议生成使用会话当前模型（与主对话同源，路由失败时面板会显示错误并可重试）。
- 回答过长时宿主端截断为头 2KB + 尾 4KB，超长代码输出的细节可能被略去。
- 页面刚加载时已存在的最后一个完成回合不会自动弹出建议，点 ✨ 手动生成即可
  （避免切换会话时刷屏）。
