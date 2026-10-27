import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { AiSettings, AiStartPayload } from '../shared/types'
import { getSettings } from '../services/configStore'
import {
  abortChat,
  newChatReqId,
  replyToolCall,
  streamChat,
  testChat,
} from '../services/aiService'

export function registerAiIpc() {
  // 发起流式对话：立即返回 reqId，增量经 ai:delta / ai:done / ai:error 事件推送
  ipcMain.handle('ai:start', (e: IpcMainInvokeEvent, payload: AiStartPayload) => {
    const reqId = newChatReqId()
    const settings = getSettings()
    void streamChat(e.sender, reqId, payload, settings.ai, settings.language)
    return reqId
  })

  // 中止进行中的对话
  ipcMain.handle('ai:abort', (_e: IpcMainInvokeEvent, reqId: string) => {
    abortChat(reqId)
  })

  // 代理模式：用户对工具调用的允许/拒绝决定
  ipcMain.handle(
    'ai:toolReply',
    (
      _e: IpcMainInvokeEvent,
      reqId: string,
      toolCallId: string,
      approved: boolean,
    ) => {
      replyToolCall(reqId, toolCallId, approved)
    },
  )

  // 连通性测试：用设置页传入的配置（即当前已保存值）发一条最小请求
  ipcMain.handle('ai:test', (_e: IpcMainInvokeEvent, ai: AiSettings) => {
    return testChat(ai)
  })
}
