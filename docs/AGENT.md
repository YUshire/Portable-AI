# 编程工作区使用指南

PortableAI 的 CLI 用于持续对话与项目任务。输入问题可以直接获得回答；输入编程任务时，模型可以读取文件、修改代码，并根据命令结果继续处理。

## 启动与连接

完整 Windows 便携运行包双击 `Start-Agent-Windows.cmd`。源码安装依赖后运行：

```powershell
node cli.mjs --connect
node cli.mjs --workspace "D:\Projects\Demo"
```

连接菜单支持云端 API、随盘模型、电脑 Ollama 模型和已保存设置。云端设置包括接口类型、基础地址、模型 ID、密钥、降级选择与可选加密保存。密钥输入不回显。

默认进入持续交互，完成一轮后可以继续输入。单次任务使用 `--task`；添加 `--interactive` 可在完成后继续交互。`--plain` 使用简洁终端。

```powershell
node cli.mjs --workspace "D:\Projects\Demo" --task "检查并修复加法函数，完成后运行测试"
node cli.mjs --workspace "D:\Projects\Demo" --usb
node cli.mjs --workspace "D:\Projects\Demo" --prefer-usb
node cli.mjs --doctor
```

`--usb` 选择随盘运行环境；`--prefer-usb` 保留云端优先，但本地降级优先使用随盘模型。权重是否需要电脑缓存，仍由文件系统和模型布局决定。

## 交互命令

| 命令 | 用途 |
|---|---|
| `/connect` | 配置连接与降级策略 |
| `/model cloud`、`/model usb`、`/model host` | 切换云端、随盘或电脑模型 |
| `/status` | 查看连接、模型、权限和会话状态 |
| `/new` | 新建会话，不撤销已完成的文件修改 |
| `/sessions` | 查看最近 20 个会话 |
| `/resume <ID>` | 恢复当前项目的已有会话 |
| `/diff` | 查看文件工具产生的修改 |
| `/help`、`/exit` | 帮助、退出 |

Enter 提交；↑↓ 查看输入历史；PgUp/PgDn 回看；Esc/Ctrl+C 取消执行中的任务，空闲时 Ctrl+C 退出。顶部显示项目、会话和实际调用模型，任务区展示回答、工具结果和修改。

## 命令确认与结果

文件工具在指定项目内读取和修改文本。运行命令默认逐条确认；非交互任务默认拒绝执行命令。可信的自动任务可以显式加入 `--allow-commands`，授权本次执行。命令具有当前用户权限，不是系统沙箱。

任务可按“读取项目 → 修改文件 → 运行测试 → 继续修复”推进。默认最多 16 步，可用 `--max-steps` 调整；重复失败会停止。当前轮降级后余下步骤使用同一个本地模型，下一轮重新按设置尝试云端。

`completed` 表示本轮已结束；`verification=passed` 表示本轮命令验证满足记录规则；`not-run` 表示未运行命令，不代表测试通过。模型回复与实际工具结果应一起查看。

## 会话保存与恢复

记录保存在程序目录 `data/agent-sessions/<会话ID>.json`，文件工具差异保存在同名 `.diff`。从 U 盘启动时，它们在 U 盘。使用 `/resume <ID>` 或：

```powershell
node cli.mjs --workspace "D:\Projects\Demo" --resume <会话ID>
```

目前恢复要求原项目路径一致。中断后结果不确定的操作不会自动重复执行。差异记录只覆盖文件工具产生的修改，不涵盖所有外部命令写入。

新会话不会自动继承旧会话，没有跨会话长期记忆或自动摘要。上下文达到容量限制时需要新建会话。退出会清理由本程序启动的本地服务，不关闭电脑原有的 Ollama 服务。

## 本地模型与适用范围

支持 Ollama 聊天模型，向量模型不能替代聊天模型。支持工具调用的模型可使用原生工具协议，其他模型可尝试结构化决策模式；返回规定格式不等于具备可靠的复杂编程能力。

本版已验证持续对话、取消后继续、会话恢复、真实小项目代码修复及云端故障后的本地接续。完整便携运行包目前只验证 Windows x64。其他模型、平台和大型项目需要分别验证。
