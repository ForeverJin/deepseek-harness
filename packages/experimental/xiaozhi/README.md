---
description: "Configure Xiaozhi Linux voice wake-up, authenticated device sessions, playback, and cancellation."
kind: "package-reference"
---
# @deepseek-ai/dsh-experimental-xiaozhi

English | [中文](README.zh.md)

<a id="summary"></a>
## Summary

Talk to a Harness Agent through the existing Xiaozhi Linux client. Wake with a configured phrase, ask follow-up questions, and hear committed replies. Continuous listening sends audio to a separate speech service even before wake-up. Install explicitly in a web profile; browser recording is outside this package.

<a id="table-of-contents"></a>
## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount alongside `webServer`, `sessionController`, `sessions`, and `agents`. The following Loader configuration is the deployment template; Linux hardware and a complete production profile need deployment verification.

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

The package must be resolvable from the profile. For a source checkout, the parent MinuSense configuration generator writes a file-URL plugin row. Its name points at the built entry instead of an unpublished npm package.

The client URL ends in `/xiaozhi/v1` without a trailing slash. Set its `websocket.token` to the device token and `websocket.version` to 3. Bind `deviceId` to `network.mac_address` in the client settings. Protocol versions 1, 2, and 3 are supported with mono 16kHz Opus and 60ms frames.

Enable `XIAOZHI_SKIP_ACTIVATION=1`, `XIAOZHI_AUTO_LISTEN=1`, and `XIAOZHI_BARGE_IN=1` in the Linux client for server-side wake-up and voice stops during playback. Each device and session binding is unique; a second simultaneous connection for that device receives HTTP 409.

| Field | Default | Behavior |
|---|---|---|
| `voiceUrl`, `voiceToken`, `devices` | Required | Speech-service endpoint, shared service token, and fixed device/session bindings |
| `path` | `/xiaozhi/v1` | Exact WebSocket upgrade path |
| `wakeWords` | `[小智小智]` | Wake prefixes; remaining words become the prompt |
| `stopWords`, `cancelWords` | `[停止, 停一下, 别说了]`, `[停止执行]` | Stop speech only, or also cancel the accepted Agent turn |
| `greeting` | `我在，请说。` | Pure wake response; no model request |
| `dialogueTimeoutMs`, `echoGuardMs` | 60000, 3000 | Dialogue window and recent speech echo guard |
| `allowBargeIn` | true | Accept new validated requests during an owned turn or playback |
| `heartbeatMs`, `handshakeTimeoutMs`, `operationTimeoutMs` | 20000, 10000, 180000 | Socket liveness, hello deadline, and accepted work deadline |
| `maxPayloadBytes`, `maxBufferedBytes`, `maxTextChars` | 65536, 262144, 12000 | Frame, queue, and transcript/answer bounds |

Waiting speech is ignored unless it starts with a wake prefix. Pure wake synthesizes the greeting. Accepted speech renews the dialogue window; a finished answer reopens it. Heartbeats and raw audio do not renew it. Reconnect restores the configured session but starts asleep and never replays historical speech.

Transport failures close the voice connection and report a retry message. Playback cancellation drops late packets by synthesis identity. Disconnect or unload cancels the device-owned turn; completed tool effects remain. Cancellation requests are not execution rollback guarantees.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

The gateway authenticates device headers before upgrade and binds each socket to a configured Harness session. The speech service performs audio decoding, segmentation, ASR, and TTS; the gateway owns wake admission and Agent delivery. Only new durable events correlated with the submitted prompt identity can trigger playback, after the turn completes. Failed attempts, reasoning, tool arguments, and interrupted prefixes are not spoken.

The Loader composition tests use a real SessionController and AgentLoop, with existing controller test fixtures for unrelated upload/query capabilities. Scripted model and voice providers make transcript, cancellation, reconnect, authentication, and disposal checks keyless.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Architecture](../../../docs/architecture.md): profile and plugin composition.
- [Session Controller](../../api/session-controller/README.md): prompt admission and cancellation.
- [WebServer](../../host/webserver/README.md): listen addresses and upgrade routes.

-----

<a id="model-experience"></a>
## Model Experience

### Accepted voice input

#### What the model sees

The final accepted ASR text, with a matching wake prefix removed, enters the ordinary user-message log. Pure wake and ignored ambient speech produce no model request. This plugin adds no tools or system prompt.

#### Token effect

Accepted text adds ordinary user-message tokens; incoming transcripts and spoken answers are capped by `maxTextChars`.

#### KV Cache effect

Accepted inputs append to the existing session history. Wake configuration and playback state do not modify the existing model prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Server-side ASR wake requires continuously uploaded audio and an available speech service; client-local keyword spotting is deferred.
- Text echo filtering is heuristic; acoustic echo cancellation and reliable noisy-room interruption require hardware validation.
- Playback uses the completed turn, not speculative sentence streaming. The provider stop marks paced transmission completion, not a client playback acknowledgement.
- Device MCP, OTA activation, MQTT/UDP, browser recording, alternate codecs, and alternate speech-service protocols are not implemented.
- Linux microphone playback, real provider calls, and complete production profile startup remain deployment acceptance work.

-----

<a id="dev-note"></a>
### Dev Note

None.
