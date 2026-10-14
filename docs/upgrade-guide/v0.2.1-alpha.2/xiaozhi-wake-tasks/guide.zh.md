---
kind: upgrade-guide
description: "小智的 sessionId 改为任务 ID 前缀，不再绑定持久对话。"
---
# 小智每次唤醒创建新任务

[English](guide.md) | 中文

## 变更

小智原先在不同唤醒和重连之间复用配置的 Harness 会话。现在每次唤醒都创建新任务，其 ID 由设备配置的 `sessionId` 与随机 UUID 组成。连续追问留在该任务，直到再次唤醒。旧任务记录保留，其历史不会加载到新任务。声学唤醒及其首条 ASR 共用一个任务。设备协议标识与桌宠阶段事件保持原有标识。

## 迁移

1. 保留 profile 的 `cordis.patch.yml` 中的 `devices[].sessionId`、`cwd` 与 `agentPreset`；`sessionId` 现在表示任务前缀。重建小智插件并重载。
2. 依赖单个固定 Harness 会话的集成需改为按配置前缀查找任务。现有会话记录无需删除或转换。
3. 唤醒小智并连续追问，然后再次唤醒。确认产生两个任务记录，连续追问位于第一个任务，第二个任务没有上一段对话上下文。
