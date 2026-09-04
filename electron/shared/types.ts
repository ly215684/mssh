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
}

/** SSH 连接设置 */
export interface SshSettings {
  /** keepalive 间隔（秒），0 = 关闭 */
  keepaliveInterval: number
  /** 连接超时（秒） */
  connectTimeout: number
  /** 启用压缩 */
  compression: boolean
}

export type Language = 'zh-CN' | 'en-US'
export type ThemeMode = 'dark' | 'light'

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
}

/** 会话标签类型 */
export type TabType = 'terminal' | 'sftp'

/** 会话标签 */
export interface SessionTab {
  id: string
  connectionId: string
  type: TabType
  /** 显示标题，如 web-prod-01 / SFTP */
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
  },
  ssh: {
    keepaliveInterval: 30,
    connectTimeout: 15,
    compression: false,
  },
}
