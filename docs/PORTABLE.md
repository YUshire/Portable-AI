# 便携部署指南

源码不包含 Node、Ollama 运行程序和模型。完整便携运行包需要自行准备对应平台的程序和有权使用的模型。

## Windows x64 运行包

准备 Node.js 22+、Ollama Windows 程序及运行库。在源码目录执行 `npm ci` 后，使用打包脚本生成新的目录：

```powershell
.\scripts\package-windows.ps1 -Target 'D:\PortableAI-Package' -NodeExe 'D:\Tools\node.exe' -OllamaDirectory 'D:\Tools\Ollama'
```

目标必须是尚不存在的新目录。保留对应运行程序与依赖的许可证，将整个目录复制到 U 盘。未导入随盘模型时，可以使用云端或电脑 Ollama 服务。

## 导入模型

先确保模型已在 Ollama 注册并可用，再指定模型库、清单和一个新的目标目录：

```powershell
node scripts/import-model.mjs 'D:\OllamaModels' 'manifests/registry.ollama.ai/library/example/latest' 'E:\PortableAI\models' 'example:latest'
```

示例中的路径和模型名需要替换为实际值。默认根据目标文件系统选择完整或分块存储；`--direct` 指定完整存储，`--chunked` 指定分块存储。当前一个随盘 models 目录携带一个模型，更换时使用新的空目标目录。

GGUF 需先在 Ollama 注册，BERT、ONNX 或向量模型不能作为此入口的聊天模型直接导入。

## 文件系统与缓存

完整权重可以容纳时，优先直接读取。只有分块时，文件系统支持大文件且空间与写入条件允许，会在 U 盘内合并并读取；已有完整权重可复用。

FAT32 单文件上限为 4 GiB−1 字节。超过上限时，优先使用校验通过的电脑完整权重；没有可用副本时才还原到缓存。缓存默认 `%LOCALAPPDATA%\PortableAI\models`，可通过 `PORTABLE_AI_CACHE` 指定其他位置。现有模型库可通过 `OLLAMA_MODELS` 指定。

盘内合并时需要同时容纳分块与完整文件。程序不会自动格式化 U 盘。实际运行仍需足够内存、合适的 CPU/GPU 与项目依赖。

## 数据随盘保存

连接配置、CLI 会话、网页历史和日志位于程序的 data/ 目录。分享运行包前移除个人数据；公开发布不能包含模型权重、密钥或个人会话。

关闭浏览器不会停止服务。使用退出入口关闭程序，等待结束后再安全弹出 U 盘。
