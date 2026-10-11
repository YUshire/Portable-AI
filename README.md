# PortableAI USB 0.1.1

Windows x64 便携聊天入口，支持用户自己的 Anthropic API、兼容 Chat Completions 的 API，以及电脑或随盘 Ollama 模型。本版生成聊天和代码文本，尚不自动编辑文件或运行命令。

## 使用和路由

1. 完整运行包放到 U 盘，双击 Start-Windows.cmd。源码包不包含运行程序和模型；开发可用 Node.js 22+ 执行 node server.mjs --open。
2. 启用云端 API，填写基础地址、模型 ID、密钥并保存。Anthropic 地址为 https://api.anthropic.com/v1；兼容接口通常以 /v1 结尾，不附加 /messages 或 /chat/completions。
3. 云端启用时优先调用云端，成功时不加载本地权重。自动降级启用后，网络、超时、HTTP 错误（含密钥、余额、模型错误）、缺失密钥或无效回复均转本地，界面显示云端失败原因。关闭降级则直接报告错误。
4. 默认使用选定的电脑 Ollama 聊天模型，缺失时加载随盘模型。未指定时自动寻找电脑聊天模型；向量模型和云模型不用于离线聊天。“本地与降级优先使用 U 盘模型”跳过电脑 Ollama。
5. “仅用本地模型”跳过云端；“仅用 U 盘模型”同时跳过云端与电脑 Ollama。
6. API 密钥默认仅存内存；可用至少 8 位密码加密保存，下次需要解锁。配置、日志和对话在 data/，不得提交 GitHub。
7. 使用“退出并清理”，等待程序退出后安全弹出 U 盘。关闭浏览器不停止服务。

## 自定义模型与存储方式

模型名、大小不写死，界面读取 models/catalog.json。可导入自己有权使用的 Ollama 聊天模型。一个 models 目录携带一个模型；更换时用新的空目标目录，避免旧分块残留。

FAT32 单文件不能达到 4 GiB。大模型需分块携带，Ollama 运行前必须合并完整权重到支持其大小的位置。首次还原到 %LOCALAPPDATA%/PortableAI/models，后续复用已验证缓存。可用 PORTABLE_AI_CACHE 指定缓存位置。空间需求由实际模型决定，缓存会留在电脑。

```text
node scripts/import-model.mjs <Ollama模型根目录> <清单相对路径> <新的随盘models目录> <模型名称>
```

exFAT/NTFS 等可容纳完整权重的 U 盘，可加 --direct 导出完整 blobs/manifests。运行时直接读取 U 盘权重，不回迁模型；首次启动校验 SHA-256。速度取决于 U 盘，仍需足够内存及适合的 CPU/GPU。

```text
node scripts/import-model.mjs <Ollama模型根目录> <清单相对路径> <新的随盘models目录> <模型名称> --direct
```

程序不会格式化 U 盘，源码不附带个人微调模型。没有随盘模型仍可使用云端或电脑 Ollama。GGUF 需先在 Ollama 注册；BERT/ONNX 权重不能直接当聊天模型导入。

## 功能边界

- Windows x64 已实测；macOS、Linux、ARM64 和手机尚未提供经过验证的运行包。
- 完整 Windows 包需要 runtime/node/node.exe、runtime/ollama/ollama.exe 和对应运行库；它们独立于源码发布，需附带各自许可。
- 云端默认超时 20 秒，本地回复等待最长 240 秒；本地上下文 4096 token，回复最多 1024 token，长对话截取近期历史。
- 仅监听 127.0.0.1，不提供局域网入口。强制终止可能留下子进程，应使用退出按钮或 Ctrl+C。

## 开发与验证

无第三方 npm 依赖，Node.js 22+：

```text
node --test tests/*.test.mjs
node server.mjs --open
```

测试覆盖云端优先、API 协议、错误降级、关闭降级、强制离线、自定义模型、直接读取、分块完整性和密钥加密。

## 来源与下一版

本实验从 [Claude-Portable](https://github.com/goddeng/Claude-Portable) 的便携部署需求发展，保留其 MIT 许可。此独立入口不依赖原项目共享 OAuth、激活码或授权服务器。

原项目封装 Claude Code CLI；[OpenClaude](https://github.com/Twigpine/openclaude) 提供云端/本地 coding-agent CLI。下一版将实现模型决策、工具执行、结果反馈和验证循环；保留本版作为聊天和连接管理入口。研究与下一轮方案见 docs/AGENT-NEXT.md。
