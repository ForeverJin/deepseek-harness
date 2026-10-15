/**
 * Session-scoped goodbye tool for voice preset sessions: the model calls it
 * when the user wants to end the dialogue, mirroring the reference server's
 * handle_exit_intent SYSTEM_CTL function. The gateway learns the call from the
 * durable `tool/call` session event and hangs the connection after the reply
 * plays out, so `execute` carries no side effects.
 * @module @deepseek-ai/dsh-experimental-xiaozhi/exit-tool
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'xiaozhi-exit-tool'
export const inject = ['tools']

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'handle_exit_intent',
    description: '当用户想结束对话或需要退出系统时调用',
    parameters: {
      say_goodbye: {
        type: 'string',
        required: true,
        description: '和用户友好结束对话的告别语',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          handled: { type: 'boolean', required: true },
        },
      },
      render: () => [{ type: 'text', text: '将播放告别语并结束本次对话' }],
    },
    async execute() {
      return { handled: true }
    },
  }))
}
