---
name: model-launcher
description: 打开本机供应商与模型面板，选择已配置的 API 供应商和模型，新建真实 Codex 桌面会话。
---

用户想通过按钮选择供应商、模型并新建会话时，调用 `open_model_panel`。
如果当前宿主不能显示 MCP App，调用 `open_launcher_browser` 并在 Codex 浏览器面板打开返回的本机链接。链接包含访问授权，不写入日志、仓库或分享给其他人。

只有用户明确要求新建时，才调用 `create_provider_thread`。使用新的 UUID 作为 operationId；相同操作重试复用原 ID。不要发送首条消息。创建结果未知时不要换新 operationId 自动重试。

供应商通过 providerId 明确选择，不按模型名字猜测。目录来自用户本机配置和供应商 `/models`。不把密钥返回前端，不要求用户把密钥贴到聊天中。

项目从 `open_model_panel` 返回的 `projects` 中选择，传入真实 projectId 和对应 roots 中的 cwd。不要用其他工具的项目 ID 代替本插件返回的项目 ID，不手填任意路径。新会话必须保存项目归属；`projectVerified` 表示项目 ID 和目录已读回确认。当前仅支持本机已有项目。

允许用户为千问等第三方模型选择 `xhigh`，不要强制改成 none。强度按选择传入，但供应商 `/models` 未必声明这些参数的能力，不能仅凭保存或读回成功宣称模型实际采用了相应推理预算。

`settings_verified` 仅证明桌面底层读回的 provider/model/effort 一致，不能证明原生输入框显示或发出的请求。若原生输入框仍显示 GPT，不要宣布千问完整可用。用户要求接入原生模型菜单时可以调用 `prepare_native_models`；它备份配置，保留现有模型并加入所选模型目录。首次设置可能需要重新启动一次。

原生输入框显示“自定义”是可以接受的，不必为了完整显示模型名而接入全局模型目录。供应商暂为空时先等恢复和设置通知，不能直接等同于已切回 OpenAI。`needs_confirmation` 可调用 `complete_provider_thread` 恢复同一会话，不另建会话；明确为其他供应商时不强行改模型。

原生目录中第三方模型使用保守的 32768 上下文上限，思考强度选项供用户明确请求，实际支持由供应商决定；未验证工具调用、长上下文或图像能力。不要声称已通过这些验证。

用户明确要求修改已有会话模型时，先确定用户提供或选择的会话，必要时调用 `list_existing_threads` 分页读取列表；不要猜测目标会话。调用 `modify_existing_thread`，threadRef 使用该会话 ID 或 codex://threads/ 链接；默认 providerId=custom、model=qwen3.8-27b、effort=xhigh。插件先核对持久化供应商，再打开原会话并修改、读回设置。供应商不一致时不得强行覆盖；needs_confirmation 不等于成功，可对同一会话重试，不另建会话。也可在原生插件设置填入会话链接，点击“修改已有会话模型”。

修改已有会话仅设置同一供应商下的模型和强度，保留上下文，不发送消息，不修改定时任务或全局模型目录。不要承诺修复调度器覆盖模型、跨供应商切换或实际推理能力，不修改认证文件，不全局切换默认供应商，不自动重新启动 Codex。

修改已有会话后检查 `requiresContextReview`、`history` 和 `note`。`verificationScope=settings_only` 始终不证明实际普通消息请求成功。历史模型与目标模型不同时，Codex 可能先用旧模型进行 ModelDownshift 压缩并失败；提示用户在原会话执行 `/compact`，等待当前模型压缩完成，再发送消息。不要自动压缩、删除或篡改历史，也不要擅自发送探测消息。历史记录不可读时必须说明核对范围有限。

用户明确要求插件独立定时后，使用 `save_model_schedule` 保存本机每日任务。先确定目标会话、任务提示词、北京时间 HH:mm 和启停状态；相同任务重试或编辑复用 id。默认 custom / qwen3.8-27b / xhigh。启用会安装隐藏后台服务及当前用户登录自启动，不修改原生模型目录。需要电脑在线且 Codex 运行；最多等待 15 分钟，不补跑旧日期。用户未要求立即执行时，不发送即时测试消息。

调用 `list_model_schedules` 查看任务和运行记录，`set_model_schedule_status` 启停。迁移既有原生定时任务时核对其状态，按用户授权通过官方 automation_update 暂停原任务，避免两边重复；不要直接改 automation.toml。未知发送结果不会自动重试；仅用户明确确认已经检查原会话后，才能调用 `acknowledge_model_schedule_run` 解除阻塞。记录为 accepted 不代表运行完成，更不证明模型已实际核对。
