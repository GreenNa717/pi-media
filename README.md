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
- 当前模型支持图片时直接传递图片；文本模型使用多模态端点生成的报告。
- 首次上传确认、密钥脱敏、报告隔离，不缓存媒体或分析结果。

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
2. 配置的多模态端点分析媒体。
3. 扩展将媒体报告作为不可信证据注入原问题。
4. 当前 Pi 模型根据原问题和媒体报告继续工作。

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

## 安全与隐私

> [!IMPORTANT]
> 媒体会上传到你配置的第三方端点。首次处理媒体时，扩展会列出文件和可能的目标主机并请求确认。

- 向导输入的 Key 保存在 `~/.pi/agent/media-router/credentials.json`，不会写入路由配置、日志或报告。
- 凭据文件未加密，请保护本机账户和用户目录。
- 媒体报告会被标记为不可信内容，文件中的指令不会直接作为模型指令执行。
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

## 友链

[LINUX DO](https://linux.do)
