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

The package ships its own bundle patch (`cordis.patch.yml` declaring the `xiaozhi-voice` row), `locale/` display metadata, and `icon.svg`, and deploys as an installed plugin bundle: link it as a profile dependency, select it in `dsh.profile.bundles`, and the Plugins page lists "Xiaozhi Voice" under installed plugins with its enable switch, uninstall control, and settings form. Machine-owned configuration lives in the profile user layer (`cordis.patch.yml`), overriding the bundle row by id; secrets stay environment expressions:

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

For local deployment, configure `localService`: `cwd` is the absolute installed Python speech-project directory and `command` is its virtual-environment Python. `args` defaults to `["-m", "xiaozhi_voice.server", "--managed"]`; startup and shutdown deadlines default to 15000ms and 5000ms. Omit `voiceUrl` and `voiceToken` in this mode. The plugin generates an ephemeral token, uses a random loopback port, mounts the device route after readiness, and awaits worker exit on unload. Unexpected exit rejects new connections; check dependencies and reload the plugin. Python, libopus, and speech providers remain deployment prerequisites; Edge TTS also requires ffmpeg. Managed mode does not install dependencies.

The package must be resolvable from the profile. For a source checkout, the parent MinuSense `tools/configure-voice.py` performs the whole provisioning (user-layer row, linked dependency, selected bundle, install) against the built package; its name points at the built entry instead of an unpublished npm package.

The client URL ends in `/xiaozhi/v1` without a trailing slash. Set its `websocket.token` to the device token and `websocket.version` to 3. Bind `deviceId` to `network.mac_address` in the client settings. Protocol versions 1, 2, and 3 are supported with mono 16kHz Opus and 60ms frames.

Enable `XIAOZHI_SKIP_ACTIVATION=1`, `XIAOZHI_AUTO_LISTEN=1`, and `XIAOZHI_BARGE_IN=1` in the Linux client for server-side wake-up and voice stops during playback. Each device and session ID prefix is unique; a second simultaneous connection for that device receives HTTP 409.

| Field | Default | Behavior |
|---|---|---|
| `voiceUrl`, `voiceToken`, `devices` | required externally | Speech service URL, shared token, device bindings; managed mode requires only device bindings |
| `localService` | disabled | Optional owned speech worker; replaces external service URL and token |
| `path` | `/xiaozhi/v1` | Exact WebSocket upgrade path |
| `wakeWords` | `[小智小智]` | Wake prefixes; remaining words become the prompt |
| `stopWords`, `cancelWords` | official 23-phrase stop list, `[停止执行]` | Whole-utterance match stops speech only, or also cancels the accepted Agent turn |
| `greeting` | `嗯` | One-syllable wake acknowledgement; no model request |
| `idleFarewellMs`, `farewell` | 120000, `时间过得真快，先聊到这里，想聊随时叫我哦。` | After this much admitted-input silence, speak the goodbye and hang the connection (official close_connection_no_voice_time pacing); the device reconnects asleep. 0 disables |
| `dialogueTimeoutMs`, `echoGuardMs` | 60000, 5000 | Dialogue window and recent speech echo guard |
| `allowBargeIn` | true | Accept new validated requests during an owned turn or playback |
| `heartbeatMs`, `handshakeTimeoutMs`, `operationTimeoutMs` | 20000, 10000, 180000 | Socket liveness, hello deadline, and accepted work deadline |
| `maxPayloadBytes`, `maxBufferedBytes`, `maxTextChars` | 65536, 262144, 12000 | Frame, queue, and transcript/answer bounds |
| `asrProvider`, `funasrUrl`, `minimaxAsrModel`, `minimaxAsrLanguage` | empty | ASR backend overrides; empty inherits the speech-service environment |
| `ttsProvider`, `edgeVoice`, `minimaxTtsModel`, `minimaxTtsVoice` | empty | TTS backend overrides; empty inherits the speech-service environment |
| `minimaxApiKey`, `minimaxBaseUrl`, `minimaxGroupId` | empty | MiniMax connection overrides; the key is write-only |
| `persona` | built-in Xiaozhi persona | Role description for voice sessions (multiline); injected through the `xiaozhi` preset and re-read on every prompt assembly |

Waiting speech is ignored unless it starts with a wake prefix. Pure wake synthesizes the greeting. Accepted speech renews the dialogue window; a finished answer reopens it. Heartbeats and raw audio do not renew it. Each wake creates an independent Harness task with the configured `sessionId` plus a random UUID; follow-ups use that task. The first ASR transcript after acoustic wake does not create another task. Reconnect starts asleep; the next wake creates a new task without restoring old context. Old task records remain available. Device protocol `session_id` and companion phase events retain the configured device identity.

Transport failures close the voice connection and report a retry message. Playback cancellation drops late packets by synthesis identity. Disconnect or unload cancels the device-owned turn; completed tool effects remain. Cancellation requests are not execution rollback guarantees.

### Speech-backend settings page

The backend-override fields above are `volatile`: the package's Plugins-page detail view embeds the settings form (registered into the `plugins.bundle.config` slot, keyed by package name; the browser half loads automatically through the package's `dsh.client` declaration, and the settings namespace is the Loader entry id, e.g. `xiaozhi-voice`). Saving writes the profile `cordis.patch.yml` and applies live: at connection open, each listen, and each synthesis the gateway compares its live configuration and sends a `configure` control to the speech service when it changed — the next utterance or synthesis uses the new backends without a service restart. The key field is write-only (stored via `role('secret')` redaction); clearing it uses the form's dedicated button. `configure` payloads carry secrets only over the `VOICE_TOKEN`-authenticated link and are never logged.

### Role description and the `xiaozhi` preset

At startup the gateway registers the `xiaozhi` agent preset with the preset registry: one `dsh-persona` row (`complete: true`, runtime context suppressed) over the persistent shell group the minimal preset ships. When a device binding selects that preset, the session's persona is the built-in speech rules plus the role description plus the current time — the rules (short spoken replies, no Markdown, ASR homophone tolerance, always answer in Chinese, at most one leading emoji) are plugin constants, the role description (the `persona` field, defaulting to the Xiaozhi persona) is edited in the settings page's role-description section, and the time line is taken fresh on every assembly so "what time is it" answers directly. Emoji split at the gateway: the client transcript (`sentence_start` text) keeps the expression, the synthesis payload strips it so TTS never reads it.

The role-description field is `volatile`: the plugin exposes it as the global prompt variable `xiaozhi_persona`, the preset's persona prefix references that variable, and every prompt assembly re-evaluates it. Saving therefore **takes effect from the next utterance without restarting Harness or recreating the voice session**; clearing it restores the built-in default. This differs from `agentPreset` and the default model, which are pinned at session creation; after changing deployment configuration and reloading the plugin, the next wake uses the new selection without deleting old tasks. Without the prompt or preset services the gateway still routes voice; only the `xiaozhi` preset is unavailable (devices bound to it fail at session creation).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

The gateway authenticates device headers before upgrade and creates a new Harness session at each wake. The speech service performs audio decoding, segmentation, ASR, and TTS; the gateway owns wake admission and Agent delivery. Only new durable events correlated with the submitted prompt identity can trigger playback, after the turn completes. Failed attempts, reasoning, tool arguments, and interrupted prefixes are not spoken.

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
