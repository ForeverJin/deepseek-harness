---
kind: upgrade-guide
description: "Xiaozhi sessionId becomes a task ID prefix instead of a persistent conversation binding."
---
# Xiaozhi creates a new task on each wake

English | [中文](guide.zh.md)

## Change

Xiaozhi previously reused the configured Harness session across wakes and reconnects. Each wake now creates a task whose ID combines the device's configured `sessionId` with a random UUID. Follow-up questions stay in that task until another wake. Old tasks remain available but their history is not loaded into new tasks. Acoustic wake and its first ASR transcript share one task. Device protocol identity and companion phase events remain unchanged.

## Migration

1. Keep `devices[].sessionId`, `cwd`, and `agentPreset` in the profile's `cordis.patch.yml`; `sessionId` now names the task prefix. Rebuild the Xiaozhi package and reload the plugin.
2. Update integrations that look up the single fixed Harness session to select tasks by the configured prefix. Existing session records require no deletion or conversion.
3. Wake Xiaozhi, ask a follow-up, then wake it again. Confirm two task records exist, with the follow-up in the first task and empty prior dialogue context in the second.
