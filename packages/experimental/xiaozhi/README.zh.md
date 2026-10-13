---
description: "配置小智 Linux 语音唤醒、设备鉴权、会话绑定、播报和取消。"
kind: "package-reference"
---
# @deepseek-ai/dsh-experimental-xiaozhi

[English](README.md) | 中文

<a id="summary"></a>
## 概述

通过现有小智 Linux 客户端与 Harness Agent 对话。使用配置的唤醒词唤醒、连续追问并收听已提交的回答。常开收音在唤醒前也会把音频发送给独立语音服务。本插件需显式挂载到 web profile；浏览器录音不属于本包。

<a id="table-of-contents"></a>
## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

本包自带 bundle patch（`cordis.patch.yml` 声明 `xiaozhi-voice` 行）、`locale/` 显示元数据与 `icon.svg`，按**已安装插件 bundle** 的方式部署：profile 依赖里 link 本包、`dsh.profile.bundles` 选中它，插件页「已安装插件」分组即出现「小智语音」卡（含启用开关、卸载与设置表单）。机器专属配置写在 profile 用户层（`cordis.patch.yml`），按行 id 覆盖 bundle 行；机密保持环境表达式：

```yaml
- id: xiaozhi-voice
  name: "@deepseek-ai/dsh-experimental-xiaozhi"
  config:
    voiceUrl: !!js process.env.VOICE_URL
    voiceToken: !!js process.env.VOICE_TOKEN
    devices:
      - deviceId: "02:00:00:00:00:01"
        token: !!js process.env.XIAOZHI_DEVICE_TOKEN
        sessionId: "xiaozhi-linux"
        cwd: "/home/user/project"
```

本机部署可配置 `localService`：`cwd` 指向已安装依赖的 Python 语音工程绝对路径，`command` 指向该工程 `.venv` 的 Python；`args` 默认 `["-m", "xiaozhi_voice.server", "--managed"]`，启动期限默认 15000ms，退出宽限默认 5000ms。此模式不填写 `voiceUrl` 或 `voiceToken`，插件生成临时 token 并使用随机回环端口。服务就绪后才注册设备路由，卸载时等待服务退出；意外退出后拒绝新连接，需要检查依赖并重载插件。Python、libopus 和语音供应商仍需配置，Edge TTS 还需要 ffmpeg；托管模式不自动安装依赖。

包必须能由 profile 解析。源码工程用父级 MinuSense 的 `tools/configure-voice.py` 一步完成部署（写用户层行、link 依赖、选中 bundle 并安装），条目指向构建入口，无需依赖尚未发布的 npm 包。

客户端 URL 以 `/xiaozhi/v1` 结束，不带末尾斜杠。`websocket.token` 使用设备 token，`websocket.version` 设为 3。`deviceId` 对应客户端设置中的 `network.mac_address`。支持协议版本 1、2、3，音频限定为单声道 16kHz Opus、60ms 帧。

Linux 客户端开启 `XIAOZHI_SKIP_ACTIVATION=1`、`XIAOZHI_AUTO_LISTEN=1`、`XIAOZHI_BARGE_IN=1`，以使用服务端唤醒和播放中的语音停止。每个设备与会话绑定必须唯一；同一设备的第二个并发连接返回 HTTP 409。

| 字段 | 默认值 | 行为 |
|---|---|---|
| `voiceUrl`、`voiceToken`、`devices` | 外部模式必填 | 语音服务地址、共享 token、设备与会话绑定；托管模式仅需设备绑定 |
| `localService` | 不启用 | 可选托管进程配置；启用时替代外部服务地址和 token |
| `path` | `/xiaozhi/v1` | WebSocket upgrade 的精确路径 |
| `wakeWords` | `[小智小智]` | 唤醒前缀；剩余文字作为请求 |
| `stopWords`、`cancelWords` | `[停止, 停一下, 别说了]`、`[停止执行]` | 仅停止播报，或同时取消已接受的 Agent 轮次 |
| `greeting` | `我在，请说。` | 纯唤醒响应，不调用模型 |
| `dialogueTimeoutMs`、`echoGuardMs` | 60000、3000 | 对话窗口和近期播报回声过滤时间 |
| `allowBargeIn` | true | 当前轮次或播放期间接受新的有效请求 |
| `heartbeatMs`、`handshakeTimeoutMs`、`operationTimeoutMs` | 20000、10000、180000 | 连接存活检查、握手期限、已接受操作期限 |
| `maxPayloadBytes`、`maxBufferedBytes`、`maxTextChars` | 65536、262144、12000 | 帧、队列、识别与回答文字上限 |
| `asrProvider`、`funasrUrl`、`minimaxAsrModel`、`minimaxAsrLanguage` | 空 | 识别后端覆盖；空值沿用语音服务环境变量 |
| `ttsProvider`、`edgeVoice`、`minimaxTtsModel`、`minimaxTtsVoice` | 空 | 合成后端覆盖；空值沿用语音服务环境变量 |
| `minimaxApiKey`、`minimaxBaseUrl`、`minimaxGroupId` | 空 | MiniMax 连接覆盖；密钥只写不读 |
| `persona` | 内置「小智」人设 | 语音会话的角色描述（多行）；经 `xiaozhi` 预设注入 system prompt，每次组装重读 |

待机语音仅在以唤醒前缀开头时被接受。纯唤醒合成问候语。有效用户输入续期对话窗口，回答结束后重新开放窗口；心跳与原始音频不续期。重连恢复配置的会话，但从待唤醒状态开始，不重播历史语音。

传输失败会关闭语音连接并提示重连。取消播报通过合成标识丢弃迟到音频。断线或卸载会取消设备拥有的轮次；已经完成的工具效果保留。取消请求不保证回滚执行结果。

### 语音后端设置页

上表的后端覆盖字段带 `volatile` 标记：WebUI「插件」页「小智语音」包详情页内嵌设置表单（表单注册进 `plugins.bundle.config` slot、按包名 keyed；浏览器半边经包声明 `dsh.client` 自动加载，设置 namespace 为 Loader 条目 id，如 `xiaozhi-voice`）。表单保存写入 profile 的 `cordis.patch.yml` 并热生效；网关在连接建立、每次收音和每次合成前对比配置快照，变化时向语音服务发送 `configure` 控制消息——下一次收音或合成即使用新后端，无需重启语音服务。密钥字段只写不读（写入经 `role('secret')` 脱敏），清除需用表单中的「清除已保存的密钥」按钮。`configure` 载荷包含密钥，仅经 `VOICE_TOKEN` 鉴权的链路传输，不会出现在日志中。

### 角色描述与 `xiaozhi` 预设

网关在启动时向预设注册表注册 `xiaozhi` Agent 预设：一个 `dsh-persona` 行（`complete: true`，抑制运行时上下文）加 minimal 同款持久 shell 组。设备行的 `agentPreset` 指向该预设时，语音会话的人设由「内建语音规则 + 角色描述」构成——语音规则（口语化短回答、禁 Markdown、容忍 ASR 同音错字等）是插件常量，角色描述（`persona` 配置，默认「小智」人设）可在设置页「角色描述」分区编辑。

角色描述字段带 `volatile` 标记：插件把它注册为全局 prompt 变量 `xiaozhi_persona`，预设的 persona 前缀引用该变量，每次提示词组装重新求值。因此**保存后从下一句话开始生效，无需重启 Harness 或删除语音会话**；清空则恢复内置默认人设。这与 `agentPreset`、默认模型的语义不同——后两者在会话创建时锁定，修改后必须删除旧会话并重启。提示词与预设服务缺失时网关照常路由语音，只是 `xiaozhi` 预设不可用（绑定该预设的设备创建会话会报错）。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节</summary>

网关在 upgrade 前验证设备请求头，并将连接绑定到配置的 Harness 会话。语音服务处理解码、切句、ASR、TTS；网关负责唤醒门控和 Agent 消息提交。只有与已提交请求标识关联的新持久事件，才能在轮次完成后触发播报；失败尝试、思考、工具参数和中断前缀不会朗读。

Loader 组合测试使用真实 SessionController 和 AgentLoop，并借助现有控制器测试夹具提供无关的上传与查询能力。模型和语音供应商采用可控脚本，使文字记录、取消、重连、鉴权、卸载检查无需 API key。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [架构](../../../docs/architecture.zh.md)：profile 与插件组合。
- [会话控制器](../../api/session-controller/README.zh.md)：消息提交与取消。
- [WebServer](../../host/webserver/README.zh.md)：监听地址与 upgrade 路由。

-----

<a id="model-experience"></a>
## 模型体验

### 已接受的语音输入

#### 模型看到什么

最终接受的 ASR 文字在去除匹配的唤醒前缀后进入普通用户消息日志。纯唤醒和被忽略的环境语音不产生模型请求。本插件不添加工具或系统提示词。

#### Token 影响

已接受的文字增加普通用户消息 token；输入识别文字与播报回答受 `maxTextChars` 限制。

#### KV Cache 影响

已接受的输入追加到现有会话历史。唤醒配置与播放状态不修改现有模型前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 服务端 ASR 唤醒需要持续上传音频及可用语音服务；客户端本地关键词检测延期。
- 文本回声过滤属于启发式保护；音频回声消除和噪声环境中的可靠打断需要硬件验证。
- 播报使用已完成轮次，不进行推测性逐句流式播放。供应商 stop 表示按节奏发送完成，不是客户端播放完成确认。
- 尚未实现设备 MCP、OTA 激活、MQTT/UDP、浏览器录音、其他编解码格式及其他语音服务协议。
- Linux 麦克风播放、真实供应商调用与完整生产 profile 启动仍需部署验收。

-----

<a id="dev-note"></a>
### 开发备注

无。
