# Codex 连接

<img src="feishu-codex-desktop/assets/icon.png" width="112" height="112" alt="Codex 连接图标">

用飞书或微信 ClawBot 继续本机 Codex 桌面的真实会话：查看项目、选择会话、发送任务，并在手机接收回复。飞书使用原生卡片和按钮，微信使用带编号、分页和操作提示的文字回复。两种通道可以同时运行，各自保存选中的会话。

已有会话保留原来的模型、项目、上下文和执行环境。插件不另起一个 Codex CLI 聊天来代替桌面会话。

0.4.1 增加第三方 HTTP Responses 新建兼容：首次在这类供应商下新建时，自动配置只监听本机的兼容转发，并提示重启 Codex 后重新提交；当次任务不会提前发送。它把缺少 `call_id` 的原生转交记录转换为普通用户消息，继续使用原供应商和模型。该供应商其他桌面对话也会经本机转发；支持关闭并恢复原地址。需要 Windows 和 Python 3.11+，详情见[兼容设置](feishu-codex-desktop/README.md#第三方-responses-新建兼容)。真实收发留给使用者验证。

继续已有会话使用桌面的普通用户消息入口，继承该会话的供应商与权限，避免把远程提问当作缺少 `call_id` 的工具结果。0.3.8 支持发送到尚未加载的会话：插件自动在桌面打开目标，等待其连接就绪后再发送，无需手动点击。**这会切换当前桌面页面；已加载的会话继续在后台接收消息。** 打开失败或等待加载超时时明确提示消息未发送；发送结果未知时不会自动重发。第三方供应商收发需在自己的桌面环境验证。

继续保留 0.3.7 对本机/SSH 会话发送时 `User-message admission requires a cloud app-server host` 错误的修复：不再强制使用云端消息入口，由桌面根据目标主机选择普通消息的处理方式。

## 在另一台机器安装

需要正在运行并已登录的 **Codex 桌面版**、**Node.js 20+**。建议安装 **Python 3**，用于完整列出本机历史会话。当前只在 Windows 实机验证过；macOS、Linux 尚未验证。仓库包含构建后的 `dist` 和完整源代码，使用插件无需 `npm install`。

在目标机器的终端执行：

```powershell
codex plugin marketplace add TheLastMagician/codex-connect --ref main
codex plugin add feishu-codex-desktop@codex-connect
```

第一条添加仓库插件源，第二条安装 **Codex 连接**。之后重启 Codex 桌面版，在新聊天中启用插件。也可以添加仓库后，在插件目录选择「Codex 连接」来源并安装。上述命令需要支持 `codex plugin` 的 Codex CLI；若命令不存在，先更新 CLI。

该仓库包含 `.agents/plugins/marketplace.json`，安装方式参照 [OpenAI 官方插件打包文档](https://developers.openai.com/plugins/build/plugins)。

### 连接微信

在 Codex 桌面聊天中说：**「用 Codex 连接插件连接微信」**。用手机微信扫描插件显示的二维码并确认。微信 ClawBot 使用扫码授权，无需飞书 App ID / Secret，也不需要安装 OpenClaw。

连接后，可以直接让操作助手找项目、选会话和转交任务；也可 `/projects` 后回复项目和会话编号。选中后仍与助手对话，`/resume` 进入会话直聊。`下一页`、`上一页` 和 `/page 2` 用于翻页，`/help` 查看所有操作。

### 连接飞书

先创建飞书自建应用机器人，开启单聊接收、发送权限及长连接事件订阅，并发布应用。在 Codex 桌面聊天中说：**「用 Codex 连接插件配置并启动飞书」**。在本机配置程序填写 App ID / Secret，然后把 `/pair 配对码` 发给飞书机器人。

要使用卡片按钮，还需开启长连接回调 `card.action.trigger` 并发布生效。[完整配置和命令说明](feishu-codex-desktop/README.md)。

**每台机器都需要单独连接和配置。** 微信扫码授权、飞书凭据、配对账号及选中会话保存在当前用户本机的 `.codex-feishu-desktop` 目录，不随仓库或插件分发。跨机器使用同一机器人时，请先停止旧机器的桥接，避免多个实例争抢同一通道。

## 更新

```powershell
codex plugin marketplace upgrade codex-connect
codex plugin add feishu-codex-desktop@codex-connect
```

更新后重启桌面版；在新聊天中重新启动桥接。微信、飞书的本机配置独立于插件文件，仍然保留。

### 随 Codex 自动连接（0.4.0）

在 Codex 中说“开启 Codex 连接自动启动”，调用 `configure_autostart(enabled=true)`。也可在插件目录执行 `node dist/setup.cjs autostart on`。首次在 Codex 设置的 **Hooks／钩子** 页审阅并信任“连接 Codex 桌面聊天通道”；CLI 可用 `/hooks`。这是 [Codex 官方钩子信任要求](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks)，插件不会替用户修改信任记录。

以后启动 Codex 并恢复或打开会话时，自动连接已配置的飞书和微信，无需再发送“启动桥接”，也不会重复配对。已有桥接会更新桌面连接，不会因多个会话同时恢复而重复启动。自动启动本身不调用模型或发送任务。仅停留在尚未加载会话的空白首页时，不保证已触发会话启动钩子。

`stop_bridge` 会暂停本次桌面运行期间的自动拉起；重启 Codex或手动 `start_bridge` 后恢复。用 `configure_autostart(enabled=false)` 或 `node dist/setup.cjs autostart off` 永久关闭自动启动；它不会停止正在运行的桥接。状态见 `bridge_status.autostart`。此设置只保存在当前机器，不随仓库或插件包分发。

## 当前范围

支持列出项目和会话、搜索标题、继续聊天、读取回复和状态、新建、重命名、置顶、归档/恢复、复制和打开会话。桥接运行期间自动回传所关注任务的回复。

飞书点击「查看对话」或发送 `/read`，按从旧到新的顺序查看最近三轮对话，包含自己的提问、Codex 进度和最终回复。每条消息有角色标识、编号和分隔线；长回复分段时保留角色和代码块。自动通知仍回传任务的最终回复。

### 模型管理和操作助手

0.3.0 支持 `/models` 查看桌面模型，`/model 模型ID`、`/effort high` 设置该会话的手机侧覆盖，`/model default` 恢复沿用桌面设置。飞书可直接点击模型卡片选择。覆盖按通道、账号、主机和会话保存，作为后续任务参数；不保证永久改变桌面中的模型选择。

操作助手使用你单独配置的 OpenAI 兼容 Chat Completions 接口。在 Codex 中调用 `configure_assistant` 配置接口、Key、模型及推理强度，或执行 `node dist/setup.cjs assistant` 在本机隐藏输入 Key。每台机器单独配置，仓库不包含任何用户的助手接口或凭据。

普通消息默认交给操作助手，无需 `/assistant` 前缀；选择、新建或复制会话后仍在助手模式。可以直接说“帮我找到某项目里的某个会话”或“把检查构建发给当前会话”。任务转交后由 Codex 桌面 agent 执行。只有 `/resume`、“进入这个会话聊天”或「进入直聊」按钮才进入会话直聊；`/assistant` 或“返回助手”退出直聊。固定命令和按钮不调用助手模型，自然语言助手会使用单独的 API 用量。

操作助手会把当前管理对话及必要的项目/会话名称和 ID 发送到你配置的接口。[完整说明](feishu-codex-desktop/README.md#模型管理与操作助手036)。

需要电脑和 Codex 桌面版持续运行。当前仅支持文字；执行审批、停止正在运行的任务仍需在桌面处理。企业微信和 QQ 尚未实现。桌面会话接口属于实验性适配，桌面更新后可能需要调整；实机验证版本为 Windows Codex 桌面 `26.1007.2314.0`。

## 开发

```powershell
cd feishu-codex-desktop
npm ci
npm test
npm run build
```

从仓库根目录打包：

```powershell
python -m pip install jsonschema
python tools/package-plugin.py
```

打包脚本验证插件清单并使用文件白名单，排除本机配置和运行凭据。自动化测试覆盖命令路由、分页、卡片、桌面请求、完整会话目录和微信登录/消息处理；实机收发仍需在已登录的桌面环境中验证。

项目结构：

```text
.agents/plugins/marketplace.json  仓库插件目录
feishu-codex-desktop/             插件包
  plugin.json / .codex-plugin/    可移植清单和 Codex 兼容清单
  .mcp.json / mcp.json            本机 MCP 服务配置
  skills/                        飞书和微信连接技能
  src/                           桌面接口、通道、路由和本机存储
  dist/                          可直接运行的构建产物
  tests/                         自动化测试
  assets/                        图标及生成提示词
tools/package-plugin.py          校验和打包
```

使用 [MIT License](LICENSE)。
