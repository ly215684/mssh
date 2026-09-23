/* ============================================================
   mssh 主/渲染进程共享类型定义
   ============================================================ */

/** 认证方式 */
export type AuthType = 'password' | 'key'

/** 服务器连接配置 */
export interface Connection {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: AuthType
  /** 密码（由 configStore 加密存储，渲染进程拿到的是明文或空） */
  password?: string
  /** 私钥文件路径 */
  privateKeyPath?: string
  /** 私钥口令 */
  keyPassphrase?: string
  /** 所属分组 id */
  groupId?: string | null
  createdAt: number
  lastUsedAt?: number
}

/** 连接分组 */
export interface ConnGroup {
  id: string
  name: string
  collapsed?: boolean
}

/** 终端设置 */
export interface TerminalSettings {
  fontFamily: string
  fontSize: number
  cursorStyle: 'block' | 'underline' | 'bar'
  cursorBlink: boolean
  scrollback: number
  bellStyle: 'none' | 'sound'
  /** 远程文本编辑器允许的最大文件大小（MB） */
  editorMaxSizeMB: number
}

/** SSH 连接设置 */
export interface SshSettings {
  /** keepalive 间隔（秒），0 = 关闭 */
  keepaliveInterval: number
  /** 连接超时（秒） */
  connectTimeout: number
  /** 启用压缩 */
  compression: boolean
  /** 意外断开后自动重连 */
  autoReconnect: boolean
  /** SFTP 传输并发请求数（1-64）。服务器 sftp 实现兼容性差时应调低 */
  transferConcurrency: number
}

export type Language = 'zh-CN' | 'en-US'
export type ThemeMode = 'dark' | 'light'

/** AI 服务商预设（均提供 OpenAI Chat Completions 兼容接口） */
export type AiProviderId =
  | 'openai'
  | 'deepseek'
  | 'moonshot'
  | 'dashscope'
  | 'bigmodel'
  | 'volcengine'
  | 'siliconflow'
  | 'custom'

/** AI 大模型设置（apiKey 由 configStore 加密落盘） */
export interface AiSettings {
  provider: AiProviderId
  /** API Key（渲染进程拿到的是明文，configStore 落盘时加密） */
  apiKey: string
  /** OpenAI 兼容接口根地址（以 /v1 等结尾，不含 /chat/completions） */
  baseUrl: string
  /** 模型名称（火山方舟等填接入点 ID，如 ep-xxx） */
  model: string
  /** 系统提示词 */
  systemPrompt: string
}

/** 对话消息（主/渲染共享，发送给兼容接口的标准结构） */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** AI 连通性测试失败类别（渲染端据此给出本地化排查提示） */
export type AiErrorCode = 'timeout' | 'proxy' | 'dns' | 'network' | 'http' | 'parse'

/** AI 连通性测试结果（设置页测试按钮） */
export interface AiTestResult {
  ok: boolean
  /** 成功时模型的简短回复 */
  reply?: string
  /** 失败时的可读错误信息 */
  error?: string
  /** 失败类别 */
  code?: AiErrorCode
}

/** 服务商预设（主/渲染共享的静态数据） */
export interface AiProviderPreset {
  id: AiProviderId
  baseUrl: string
  model: string
}

export const AI_PROVIDER_PRESETS: AiProviderPreset[] = [
  { id: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'moonshot', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  {
    id: 'dashscope',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
  },
  { id: 'bigmodel', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { id: 'volcengine', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: '' },
  { id: 'siliconflow', baseUrl: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3' },
  { id: 'custom', baseUrl: '', model: '' },
]

/** 应用设置 */
export interface AppSettings {
  language: Language
  theme: ThemeMode
  /** 启动时恢复上次会话 */
  restoreSession: boolean
  /** 自动检查更新 */
  autoUpdate: boolean
  terminal: TerminalSettings
  ssh: SshSettings
  ai: AiSettings
}

/** 会话标签类型 */
export type TabType = 'terminal' | 'sftp' | 'docker' | 'cron'

/** 会话标签 */
export interface SessionTab {
  id: string
  connectionId: string
  type: TabType
  /** 显示标题，如 web-prod-01 / SFTP / AI */
  title: string
}

/** 布局持久化（会话恢复） */
export interface LayoutState {
  tabs: SessionTab[]
  activeTabId: string | null
}

/** 文件条目（本地/远程通用） */
export interface FileInfo {
  name: string
  /** 完整路径 */
  path: string
  isDir: boolean
  size: number
  /** 修改时间 ms */
  mtime: number
  /** 权限（远程） */
  mode?: number
  symlink?: boolean
}

/** SSH 会话信息（连接成功后回传） */
export interface SshSessionInfo {
  sessionId: string
  /** 协商的加密算法，如 aes256-ctr */
  cipher: string
  kex: string
  host: string
  port: number
  username: string
}

/** 远程服务器实时资源占用（CPU 1 秒采样，内存/磁盘快照） */
export interface SysStats {
  /** CPU 使用率 0-100 */
  cpu: number
  /** 内存使用率 0-100 */
  mem: number
  /** 内存已用 MB */
  memUsed: number
  /** 内存总量 MB */
  memTotal: number
  /** 磁盘使用率 0-100 */
  disk: number
  /** 磁盘已用 GB */
  diskUsed: number
  /** 磁盘总量 GB */
  diskTotal: number
}

/** SSH 一次性命令执行结果 */
export interface ExecResult {
  /** 退出码（0 成功） */
  code: number
  stdout: string
  stderr: string
}

/** Docker 容器（docker ps 解析结果） */
export interface DockerContainer {
  /** 短 ID */
  id: string
  name: string
  image: string
  /** running / exited / paused / restarting / created / dead */
  state: string
  /** 人类可读状态，如 "Up 2 hours" / "Exited (0) 3 days ago" */
  status: string
  /** 端口映射文本 */
  ports: string
}

/** Docker 镜像（docker images 解析结果） */
export interface DockerImage {
  /** 短 ID */
  id: string
  repository: string
  tag: string
  /** 人类可读大小，如 "123MB" */
  size: string
}

/** 传输方向 */
export type TransferDirection = 'upload' | 'download'

/** 传输状态 */
export type TransferStatus = 'pending' | 'active' | 'done' | 'error' | 'cancelled'

/** 传输任务 */
export interface TransferItem {
  id: string
  direction: TransferDirection
  connectionId: string
  localPath: string
  remotePath: string
  /** 显示名（文件名） */
  name: string
  size: number
  transferred: number
  status: TransferStatus
  /** 字节/秒 */
  speed: number
  error?: string
}

/** 自动更新事件（主进程 → 渲染进程） */
export interface UpdateEvent {
  type: 'checking' | 'available' | 'not-available' | 'progress' | 'downloaded' | 'error'
  payload?: {
    version?: string
    /** 0-100 */
    percent?: number
    transferred?: number
    total?: number
    bytesPerSecond?: number
    message?: string
  }
}

/** 配置一次性全量返回 */
export interface AllConfig {
  settings: AppSettings
  connections: Connection[]
  groups: ConnGroup[]
  layout: LayoutState | null
  dataDir: string
}

/** 默认设置 */
export const DEFAULT_SETTINGS: AppSettings = {
  language: 'zh-CN',
  theme: 'dark',
  restoreSession: false,
  autoUpdate: false,
  terminal: {
    fontFamily: "'Cascadia Mono', Consolas, 'Courier New', monospace",
    fontSize: 14,
    cursorStyle: 'block',
    cursorBlink: true,
    scrollback: 5000,
    bellStyle: 'none',
    editorMaxSizeMB: 2,
  },
  ssh: {
    keepaliveInterval: 30,
    connectTimeout: 15,
    compression: false,
    autoReconnect: true,
    transferConcurrency: 4,
  },
  ai: {
    provider: 'deepseek',
    apiKey: '',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    systemPrompt:
      '你是一名经验丰富的 Linux 运维与开发专家，内置在 SSH 客户端 mssh 中。' +
      '请简洁、准确地回答问题；涉及命令时优先给出可直接复制执行的代码块，' +
      '并注明适用场景与风险。回答使用与用户提问相同的语言。',
  },
}
