import type {
  AllConfig,
  AppSettings,
  ConnGroup,
  Connection,
  ExecResult,
  FileInfo,
  LayoutState,
  SshSessionInfo,
  SshSettings,
  SysStats,
  TransferItem,
  UpdateEvent,
} from './types'

/** preload 通过 contextBridge 暴露给渲染进程的 API（主/渲染共享类型） */
export interface RendererApi {
  /** 运行平台 */
  platform: NodeJS.Platform
  /** 窗口控制（自定义标题栏） */
  win: {
    minimize: () => void
    maximize: () => void
    close: () => void
  }

  // ---- 配置持久化 ----
  getConfig: () => Promise<AllConfig>
  saveSettings: (settings: AppSettings) => Promise<void>
  saveConnection: (conn: Connection) => Promise<void>
  deleteConnection: (id: string) => Promise<void>
  saveGroup: (group: ConnGroup) => Promise<void>
  deleteGroup: (id: string) => Promise<void>
  saveLayout: (layout: LayoutState) => Promise<void>
  openPath: (p: string) => Promise<boolean>
  /** 系统对话框选择私钥文件 */
  pickPrivateKey: () => Promise<string | null>
  /** 拖拽文件 → 真实磁盘路径 */
  pathForFile: (file: File) => string
  /** 剪贴板 */
  clipboardReadText: () => Promise<string>
  clipboardWriteText: (text: string) => Promise<void>

  // ---- SSH ----
  sshConnect: (conn: Connection, sshSettings: SshSettings) => Promise<SshSessionInfo>
  sshWrite: (sessionId: string, data: string) => void
  sshResize: (sessionId: string, cols: number, rows: number) => void
  sshDisconnect: (sessionId: string) => Promise<void>
  /** 获取远程服务器 CPU/内存/磁盘占用（阻塞约 1.5 秒） */
  sshStats: (sessionId: string) => Promise<SysStats>
  /** 通过 SSH 执行一次性命令，返回 stdout/stderr/退出码 */
  sshExec: (sessionId: string, command: string) => Promise<ExecResult>
  /** 启动流式命令（日志跟随 / compose 长任务），返回 streamId */
  sshExecStream: (sessionId: string, command: string) => Promise<string>
  /** 终止流式命令 */
  sshStreamKill: (streamId: string) => void
  /** 流式命令输出订阅（kind: stdout/stderr），返回取消订阅函数 */
  onSshStreamData: (
    cb: (streamId: string, data: string, kind: 'stdout' | 'stderr') => void,
  ) => () => void
  /** 流式命令结束订阅，返回取消订阅函数 */
  onSshStreamClose: (cb: (streamId: string, code: number) => void) => () => void
  /** 返回取消订阅函数 */
  onSshData: (sessionId: string, cb: (data: string) => void) => () => void
  /** 会话退出订阅（reason 为可读断开原因），返回取消订阅函数 */
  onSshExit: (sessionId: string, cb: (reason: string) => void) => () => void
  /** 全局 SSH 退出事件（不过滤会话），返回取消订阅函数 */
  onAnySshExit: (cb: (sessionId: string, reason: string) => void) => () => void

  // ---- SFTP（远程） ----
  sftpList: (sessionId: string, dir: string) => Promise<FileInfo[]>
  sftpMkdir: (sessionId: string, dir: string) => Promise<void>
  sftpRm: (sessionId: string, path: string) => Promise<void>
  sftpRename: (sessionId: string, from: string, to: string) => Promise<void>
  sftpRealpath: (sessionId: string, path: string) => Promise<string>
  sftpHome: (sessionId: string) => Promise<string>
  /** 读取远程文本文件（>2MB 或二进制会抛错） */
  sftpReadFile: (sessionId: string, path: string) => Promise<string>
  /** 写入文本到远程文件（覆盖） */
  sftpWriteFile: (sessionId: string, path: string, content: string) => Promise<void>
  /** 创建空远程文件 */
  sftpTouch: (sessionId: string, path: string) => Promise<void>
  /** 远程解压（解压到同目录） */
  sftpExtract: (sessionId: string, path: string) => Promise<void>
  /** 上传（支持目录递归），返回传输任务 id 列表 */
  sftpUpload: (sessionId: string, localPaths: string[], remoteDir: string) => Promise<string[]>
  sftpDownload: (sessionId: string, remotePaths: string[], localDir: string) => Promise<string[]>
  /** 取消传输任务（等待中立即取消；进行中的中断后续写入） */
  cancelTransfer: (id: string) => Promise<boolean>
  /** 传输进度事件（返回取消订阅函数） */
  onTransfer: (cb: (item: TransferItem) => void) => () => void

  // ---- 本地文件 ----
  localList: (dir: string) => Promise<FileInfo[]>
  localHome: () => Promise<string>
  localDesktop: () => Promise<string>
  localDrives: () => Promise<string[]>
  localMkdir: (path: string) => Promise<void>
  localRm: (path: string) => Promise<void>
  localRename: (from: string, to: string) => Promise<void>
  /** 创建空本地文件 */
  localTouch: (path: string) => Promise<void>
  /** 本地解压（解压到同目录） */
  localExtract: (path: string) => Promise<void>

  // ---- 自动更新 ----
  /** 更新器是否可用（dev / 未签名环境为 false） */
  updateActive: () => Promise<boolean>
  /** 检查更新，返回最新版本号；不可用或失败返回 null（事件里会有错误详情） */
  updateCheck: () => Promise<string | null>
  updateDownload: () => Promise<void>
  /** 退出并安装已下载的更新 */
  updateInstall: () => Promise<void>
  /** 更新事件订阅（返回取消订阅函数） */
  onUpdateEvent: (cb: (e: UpdateEvent) => void) => () => void
}
