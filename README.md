# Codex 插件工作区

每个插件放在独立目录中，源码、界面、构建产物、测试、文档和打包工具都跟随各自项目。

| 插件 | 项目目录 | 用途 |
| --- | --- | --- |
| [Codex 连接](codex-connect/README.md) | `codex-connect/` | 通过飞书、微信连接本机 Codex 会话 |
| [供应商与模型](codex-model-switcher/README.md) | `codex-model-switcher/` | 管理供应商、模型和定时任务 |

```text
plugin/
  codex-connect/                  Codex 连接项目
    src/ web/ assets/ skills/     源码、界面、资源和技能
    dist/ tests/ scripts/         构建产物、测试和构建脚本
    tools/package-plugin.py      校验和打包
    docs/ CHANGELOG.md           安装说明和历史记录
    releases/                   本机安装包，不提交到 Git
  codex-model-switcher/          供应商与模型项目
    releases/                   本机安装包，不提交到 Git
  .agents/plugins/marketplace.json  共用的仓库插件目录
  .github/workflows/             共用的 CI 配置
```

## 开发与打包

以下命令从工作区根目录执行：

```powershell
npm --prefix codex-connect test
npm --prefix codex-connect run build
python codex-connect/tools/package-plugin.py

npm --prefix codex-model-switcher test
npm --prefix codex-model-switcher run build
python codex-model-switcher/scripts/package.py
```

两个插件的安装包分别输出到各自的 `releases/`，凭据和运行状态继续保存在用户本机的私有配置目录。

## 从 GitHub 安装

仓库地址和插件标识保持不变：

```powershell
codex plugin marketplace add TheLastMagician/codex-connect --ref main
codex plugin add feishu-codex-desktop@codex-connect
codex plugin add codex-model-switcher@codex-connect
```

Codex 连接的完整安装与自动启动说明见 [安装指南](codex-connect/docs/installation.md)。

后续新增插件时，在顶层新建同级项目目录，再将其加入 `.agents/plugins/marketplace.json`，按需添加 CI 任务。共用 Git 历史保留在工作区根目录。

使用 [MIT License](LICENSE)。
