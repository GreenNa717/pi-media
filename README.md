<div align="center">

# Pi Media Router

让 Pi 的纯文本模型通过可配置的多模态端点理解图片、音频、视频和 PDF。

![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.19-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

</div>

Pi Media Router 是一个独立的 [Pi](https://github.com/earendil-works/pi) Package。它自动识别会话中的媒体文件，让多模态模型生成分析报告，再将报告交给当前 Pi 模型继续处理，不修改 Pi 核心。

## 功能

- 自动识别图片附件、剪贴板临时文件、拖入路径、裸路径和 `@路径`。
- 支持图片、音频、视频和 PDF，并校验文件后缀与实际 MIME。
- 根据最近会话和用户问题生成媒体分析任务。
- 支持多端点路由、并发处理、失败重试和顺序回退。
- 实时显示多模态模型输出，完成后保留带端点和模型名称的独立报告卡片。
- 向主模型提供 `media_query` 工具，可在后续回合重新检查原媒体。
- 当前模型支持图片时直接传递图片；文本模型使用多模态端点生成的报告。
- 首次上传确认、密钥脱敏和不可信证据隔离，不持久缓存原始媒体。

## 安装

要求 Node.js `>=22.19.0` 和 Pi。项目已使用 Pi `0.83.0` 验证。

```bash
pi install git:github.com/GreenNa717/pi-media
```

安装后重启 Pi，或在当前会话运行 `/reload`。

## 配置

进入 Pi 后运行：

```text
/media setup
```

向导会要求选择协议、API URL、API Key、模型和媒体类型。配置完成后检查路由：

```text
/media doctor
```

全局配置保存在 `~/.pi/agent/media-router.json`，项目配置保存在 `<project>/.pi/media-router.json`。完整配置示例见 [examples/media-router.json](./examples/media-router.json)。

## 使用

完成配置后，直接粘贴、拖入或输入媒体文件路径：

```text
D:\media\photo.png 描述这张图片
D:\media\meeting.mp3 总结会议内容
D:\media\clip.mp4 提取关键时间点
```

扩展会自动执行以下流程：

1. 当前 Pi 模型结合问题与近期会话生成分析任务。
2. 配置的多模态端点分析媒体，输出实时显示在固定面板中。
3. 完整报告保存为独立卡片，并作为不可信证据注入主模型上下文。
4. 当前 Pi 模型根据原问题和报告继续工作。

报告不够详细时，直接继续提问：

```text
再仔细看刚才图片右上角的报错，给出完整文字和可能原因
```

主模型会自动调用 `media_query`，把具体问题和原媒体再次交给多模态端点，然后继续回答。工具只接受会话中显示的 `media_...` ID，不接受文件路径、URL 或端点地址。

强制指定端点或请求完整转写：

```text
/media --endpoint media --detail full @"D:\media\meeting.mp3" -- 完整转写并区分说话人
```

### 命令

| 命令 | 作用 |
| --- | --- |
| `/media setup` | 配置多模态端点和路由 |
| `/media doctor` | 检查配置、鉴权和路由 |
| `/media doctor --probe` | 发送最小文本请求测试端点 |
| `/media trust reset` | 清除当前项目的上传许可 |
| `/media @file -- <问题>` | 强制分析指定媒体 |

> [!WARNING]
> `/media doctor --probe` 会访问已配置的端点，可能产生少量费用。

## 支持的协议

| 协议 | 媒体类型 |
| --- | --- |
| OpenAI Chat Completions | 图片、MP3/WAV 音频 |
| OpenAI Responses | 图片、PDF |
| Anthropic Messages | 图片、PDF |
| Gemini GenerateContent / Interactions | 图片、音频、视频、PDF |

扩展只发送协议定义的内容块，不猜测 `video_url` 等非标准兼容格式。

分析请求默认使用流式接口。端点返回普通 JSON 时仍可解析；端点在产生增量前明确拒绝流式请求时，扩展会回退一次非流式请求。流式传输中途失败时，未完成内容会被丢弃，并按路由尝试下一个端点。Gemini 自定义流式路径可通过端点的 `streamPath` 设置。

## 媒体生命周期

- 原始媒体只保留在当前 Pi 运行会话的内存中；退出、重载、切换会话、分叉或切换会话树后清空。
- 报告卡片随 Pi 会话保存，但媒体清空后不能继续精查，需要重新发送文件。
- 注册表最多保留 32 个媒体和 128 MiB 内联图片，超限时按最近使用顺序淘汰。
- 文件型媒体再次使用前会校验真实路径、大小、修改时间、MIME 和文件签名；文件变化后必须重新发送。
- 单次 `media_query` 最多查询 8 个已登记媒体。

## 安全与隐私

> [!IMPORTANT]
> 媒体会上传到你配置的第三方端点。首次处理媒体时，扩展会列出文件和可能的目标主机并请求确认。

- 向导输入的 Key 保存在 `~/.pi/agent/media-router/credentials.json`，不会写入路由配置、日志或报告。
- 凭据文件未加密，请保护本机账户和用户目录。
- 媒体报告会被标记为不可信内容，文件中的指令不会直接作为模型指令执行。
- 报告通过上下文钩子提供给主模型，不会以大段分析文本改写用户消息。
- Gemini Files API 上传的远端文件会在请求结束后尽力删除。
- 模型列表只表示当前 Key 可以访问模型，不代表模型支持所有媒体类型。

## 开发

```bash
npm install
npm run check
npm test
npm run pack:dry
```

自动化测试使用本地模拟服务，不调用真实模型。

## 社区支持

https://linux.do
