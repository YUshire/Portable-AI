# 便携编程代理 0.3.1

## 0.3.1 模式切换修正

修复 `/connect` 从“仅用电脑本地模型”切换到“仅用 U 盘模型”后仍被旧 `hostOnly` 标记阻止的问题。切换到 U 盘模式会清除电脑限定并选择随盘模型；运行时也保证显式 U 盘模式优先于残留的电脑限定。选择电脑模式且没有可用模型时仍明确报错，不会自行加载 U 盘权重。

41 项自动测试通过，包括电脑→U 盘、残留标记与显式 U 盘参数冲突、返回云端设置及既有电脑限定行为。Windows 完整 U 盘包在同一终端内实测：电脑模式输入“你是什么”报缺少模型，随后 `/connect` 选择 2、再次输入同一问题，成功调用真实随盘 MindBridge 模型并返回，状态 completed。

## 持续终端工作区

不传 `--task` 时进入 Ink / React 终端界面。完成任务后继续输入，保留上下文、工具结果和文件修改记录；本地 Ollama 进程持续复用到退出。顶部展示项目、会话及实际调用模型，中间显示工具、命令结果和修改，底部输入任务。支持中文显示宽度、终端尺寸变化、↑↓ 输入历史、PgUp/PgDn 回看。

`--task` 保持脚本调用的一次性模式；加 `--interactive` 执行完后继续交互。`--plain` 使用简洁终端。默认命令逐条确认；输入 y 后才执行。Esc/Ctrl+C 取消当前任务并返回输入，空闲时 Ctrl+C 退出。关闭时保存会话和文件工具 diff，停止由本程序启动的 Ollama。

| 命令 | 用途 |
| --- | --- |
| `/connect` | 配置 API 类型、地址、模型、隐藏密钥、降级方式和可选加密保存 |
| `/model cloud` | 云端优先；按已配置策略降级 |
| `/model usb` | 强制随盘模型 |
| `/model host` | 仅用电脑 Ollama，缺失时报错 |
| `/status` | 查看连接、权限、会话和模型步骤 |
| `/new` | 清空上下文，新建会话；不撤销实际文件修改 |
| `/sessions` | 最近 20 个会话 |
| `/resume <ID>` | 恢复当前项目的指定会话 |
| `/diff` | 查看文件工具造成的修改 |
| `/help`、`/exit` | 帮助、退出 |

每一轮新任务重新尝试云端优先，当前轮降级后余下步骤使用同一个本地模型。本轮验证状态只计算本轮命令，不把上一轮的测试成功或失败计入新任务。历史容量仍有限，达到限制时用 `/new` 新建会话。

终端依赖约 7 MB，完整运行包已附带，不需要在目标电脑安装 npm 包。源码开发先运行 `npm ci`；Windows 打包脚本携带 node_modules 和第三方许可。这个界面是我们现有 Agent 的新前端，未嵌入 Claude Code、Codex 或 Kimi 的实现，也没有其完整能力。框架参考：[Ink](https://github.com/vadimdemedes/ink)、[Crush](https://github.com/charmbracelet/crush)、[Kimi Code](https://github.com/MoonshotAI/kimi-code)。

0.3.0 验证：38 项自动测试通过，包含首次输入焦点、连续输入、密钥遮罩、取消后继续和多轮验证状态隔离；Windows PTY 实测多轮会话、命令确认、Esc 取消后继续、彩色界面及连接菜单。完整 U 盘包使用随盘 Node 执行同一测试集通过，真实随盘 MindBridge 模型完成读取、修改、运行断言的 4 步修复；复用完整缓存，没有重复回迁。付费云端使用协议模拟服务验证，未调用用户付费 API。

## 启动

Windows 完整 U 盘运行包：双击 `Start-Agent-Windows.cmd`，先选择连接方式。默认进入云端 API 配置，询问接口类型、基础地址、模型 ID、密钥（不回显）、降级选项和是否加密保存，然后填写项目文件夹路径和任务。也可选仅用 U 盘、仅用电脑或已保存设置。原来的 `Start-Windows.cmd` 继续启动聊天界面。

命令行方式（在 PortableAI 目录中）：

```cmd
runtime\node\node.exe cli.mjs --workspace "D:\MyProject" --task "修复函数并运行测试"
runtime\node\node.exe cli.mjs --workspace "D:\MyProject" --usb --task "检查并修复加法实现"
runtime\node\node.exe cli.mjs --workspace "D:\MyProject" --prefer-usb --task "完成修改后运行测试"
runtime\node\node.exe cli.mjs --doctor
```

`--usb` 强制只用随盘模型；`--prefer-usb` 保留云端优先，但本地降级选择随盘模型；`--host` 优先用电脑 Ollama。具体模型可用 `--local-model` 指定。

## 云端配置

读取聊天界面保存的接口类型、基础地址、模型名和降级设置。密钥默认在聊天进程内存中，新的 CLI 进程不能读取该内存；CLI 可单独输入密钥、解锁保存的加密密钥，或读取环境变量 `PORTABLE_API_KEY`。密码输入不显示。环境变量与密钥不写进 agent 会话。

也可显式指定 `--provider anthropic|compatible --api-base <地址> --model <模型ID>`。源码不内置付费 API 密钥，本轮真实云端付费模型未测试；协议与故障场景通过模拟服务验证。

云端请求失败后按设置降级；本轮任务余下步骤持续使用本地，避免每一步反复请求故障云端。转换保留工具调用与结果配对。`--offline` 跳过云端。

## 工具与命令

- `list_files`：列出项目目录。
- `read_file`：读取 UTF-8 文件，支持行号范围。
- `write_file`：创建/替换小型文本文件。
- `edit_file`：只替换一个明确匹配的片段。
- `run_command`：在项目目录用程序名和 argv 执行命令，反馈退出码与输出。

文件工具检查真实路径，拒绝越界或通过目录联接访问外部文件；不操作 `.git`、`.env`，不处理二进制或超过 512 KiB 的文本文件。命令不会自动使用 shell，`node` 映射为随盘 Node，项目依赖仍需该项目实际具备。

默认逐条确认命令；非交互运行默认拒绝。明确传入 `--allow-commands` 即授权本次任务执行模型选择的命令。命令具有电脑当前用户权限，**不是文件系统沙箱**，可影响项目目录之外；不要把该参数用于不信任的项目和任务。命令默认 60 秒超时，Ctrl+C 会取消请求并停止自有命令进程树。

## 循环、记录与恢复

模型请求 → 执行工具 → 反馈工具结果 → 再请求模型。运行测试失败后，模型有机会继续修复；同一工具连续失败三次停止，默认最多 16 轮，可用 `--max-steps 1..100` 调整。

记录保存在 `data/agent-sessions/<会话ID>.json`；文本文件变化记录为同名 `.diff`。可用 `--resume <会话ID>` 恢复，必须使用原项目目录。中断时结果未知的操作不自动重放，模型先收到未知结果提示。diff 记录文件工具造成的修改，不捕获命令程序自身产生的全部文件变化。配置、会话和 diff 均排除 GitHub。

最后一次命令失败、被拒绝、超时，或测试后又改了文件，会标为 `needs-review`，不会仅凭模型文字宣布验证通过。没有执行命令时 `verification=not-run`，不能解读为测试通过。会话包含完整工具结果，但上下文有容量上限，不无限循环。

## 本地模型能力与本轮实测

`--local-protocol auto`：模型声明原生 `tools` 能力时使用 Ollama 原生工具协议；否则使用实验性的 JSON Schema 决策。`native` 强制原生；`json` 强制结构化决策。JSON 限制返回格式，无法保证模型具备可靠的复杂编程能力。

随盘 MindBridge 模型当前只声明 `completion`。本轮实测了 4 步离线修复：读取 add.mjs → 将减法改为加法 → 执行两项断言 → 完成。另一个实测模拟云端 503，降级到真实随盘模型完成同一任务。小任务通过不代表大型项目能力与 Claude Code 相当。

当前完整包只验证 Windows x64。原生工具调用模型的适配器通过模拟 Ollama 验证，随盘模型走的是 JSON 决策；其他模型和其他系统应分别验证。

## 开发测试

```text
node --test tests/*.test.mjs
node scripts/smoke-agent.mjs <完整运行包目录> <报告.json> usb
node scripts/smoke-agent.mjs <完整运行包目录> <报告.json> fallback
```

真实 smoke 使用独立临时项目，真实修改文件和执行断言，保留会话与报告。不会改用户项目或保存个人 API 密钥；fallback 服务使用本机模拟 HTTP 503。

## 0.2.1 连接与缓存修正

运行 node cli.mjs --configure 可只配置云端并退出，不加载本地模型。node cli.mjs --connect 会显示连接菜单。非交互自动任务继续支持原有 --api-base/--model/--provider 参数和 PORTABLE_API_KEY。

程序现在先打印连接方式，再开始任务。选云端时成功请求不会还原模型。分块模型准备时会显示实际缓存路径，先验证默认缓存、OLLAMA_MODELS 指定的现有模型库以及 Codex 应用缓存目录。匹配同一清单和 SHA-256 的完整模型可直接复用；指定 PORTABLE_AI_CACHE 时只使用显式缓存位置。只有没有可复用完整权重时才合并 U 盘分块。这样可以避免 Codex 打包应用与用户双击运行访问不同缓存位置造成的重复复制。
