# 下一轮：便携 coding agent

## 核对的上游实现

- Claude-Portable： https://github.com/goddeng/Claude-Portable 。README 明确说明封装 Claude Code CLI，启动器完成部署与授权，编程代理能力来自 Claude Code。
- OpenClaude： https://github.com/Twigpine/openclaude 。README 将其定义为支持云端/本地模型的 coding-agent CLI，具备文件工具、命令、MCP、流式输出与 provider 配置。
- 闭环源码： https://github.com/Twigpine/openclaude/blob/main/src/query.ts 。查询循环执行模型请求，处理 tool_use，调用 runTools/StreamingToolExecutor，收集 toolResults，再把模型消息和工具结果加入下一轮 state。

## 下一轮实现与验证

1. CLI 在用户指定项目目录运行，提供单次任务、交互任务及恢复会话。
2. 云端/本地路由共用连接配置，支持工具调用结构；切换后保留完整工具调用与结果配对。当前只提取文本的适配器需要扩展。
3. 支持目录列表、文件读取、补丁编辑和测试命令。文件访问约束在指定项目目录，命令执行展示目标与结果；写操作产生可审查 diff。
4. 工具结果送回模型，迭代到目标完成、步骤/时间限制或明确错误。支持 Ctrl+C、重复失败检测和状态恢复。
5. 验证完整任务：读取一个小项目 → 修改函数 → 运行测试 → 测试失败后修复 → 通过并输出 diff。
6. 本地降级需测试模型工具调用能力；支持聊天不代表支持可靠 agent。
7. 比较封装现有 OpenClaude 与小型自有循环的便携依赖、Windows 工具执行和 API 兼容性，再确定实现。

0.1.1 保留聊天界面，已修复路由与模型提示。此文档是下一轮方案，尚未将以上 agent 能力计为已完成。
