# Codex 连接

<img src="feishu-codex-desktop/assets/icon.png" width="112" height="112" alt="Codex 连接图标">

用飞书或微信 ClawBot 继续本机 Codex 桌面的真实会话：查看项目、选择会话、发送任务，并在手机接收回复。飞书使用原生卡片和按钮，微信使用带编号、分页和操作提示的文字回复。两种通道可以同时运行，各自保存选中的会话。

已有会话保留原来的模型、项目、上下文和执行环境。插件不另起一个 Codex CLI 聊天来代替桌面会话。

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

连接后，在微信 ClawBot 聊天里发送 `/projects`，回复项目编号查看会话，再回复会话编号选择。选中后直接发任务即可。`下一页`、`上一页` 和 `/page 2` 用于翻页，`/help` 查看所有操作。

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

## 当前范围

支持列出项目和会话、搜索标题、继续聊天、读取回复和状态、新建、重命名、置顶、归档/恢复、复制和打开会话。桥接运行期间自动回传所关注任务的回复。

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
