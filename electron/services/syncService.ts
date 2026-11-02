import { app, BrowserWindow, dialog, net } from 'electron'
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type {
  AllConfig,
  SyncData,
  SyncEnvelope,
  SyncFileResult,
  SyncScope,
  SyncUploadResult,
  WebDavSettings,
  WebDavTestResult,
} from '../shared/types'
import {
  applySyncData,
  buildSyncData,
  getAll,
  getSettings,
  saveSettings,
} from './configStore'

const ITERATIONS = 100_000
const REQUEST_TIMEOUT = 30_000

// ---------- 加解密 ----------

function deriveKey(password: string, salt: Buffer, iterations: number) {
  return pbkdf2Sync(password, salt, iterations, 32, 'sha256')
}

/** 将同步载荷加密为信封结构 */
function encryptData(data: SyncData, password: string): SyncEnvelope {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', deriveKey(password, salt, ITERATIONS), iv)
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()])
  return {
    format: 'mssh-sync',
    version: 1,
    alg: 'aes-256-gcm',
    kdf: 'pbkdf2-sha256',
    iterations: ITERATIONS,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64'),
    createdAt: Date.now(),
  }
}

/** 解密信封并校验同步载荷字段 */
function decryptEnvelope(raw: string, password: string): SyncData {
  let envelope: Partial<SyncEnvelope>
  try {
    envelope = JSON.parse(raw) as Partial<SyncEnvelope>
  } catch {
    throw new Error('文件格式不正确')
  }
  if (
    envelope.format !== 'mssh-sync' ||
    envelope.version !== 1 ||
    !envelope.salt ||
    !envelope.iv ||
    !envelope.tag ||
    !envelope.data
  ) {
    throw new Error('不是有效的 mssh 同步备份文件')
  }

  let data: SyncData
  try {
    const iterations = envelope.iterations ?? ITERATIONS
    const decipher = createDecipheriv(
      'aes-256-gcm',
      deriveKey(password, Buffer.from(envelope.salt, 'base64'), iterations),
      Buffer.from(envelope.iv, 'base64'),
    )
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
    const plain = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, 'base64')),
      decipher.final(),
    ]).toString('utf8')
    data = JSON.parse(plain) as SyncData
  } catch {
    throw new Error('同步口令错误或文件已损坏')
  }

  const connectionsOnly = data?.scope === 'connections'
  if (
    !data ||
    !Array.isArray(data.connections) ||
    !Array.isArray(data.groups) ||
    (!connectionsOnly && !data.settings)
  ) {
    throw new Error('备份内容不完整')
  }
  return data
}

function requirePassword(password: string) {
  if (!password.trim()) throw new Error('请先设置同步口令')
}

/** 本机尚未设置同步口令时，成功后自动记住本次输入的口令 */
function rememberPassword(password: string) {
  const current = getSettings()
  if (!current.sync.password.trim()) {
    saveSettings({ ...current, sync: { ...current.sync, password } })
  }
}

function applyDecrypted(raw: string, password: string): AllConfig {
  const data = decryptEnvelope(raw, password)
  applySyncData(data)
  rememberPassword(password)
  // 重新读取，确保自动记住的同步口令也回传给渲染进程
  return getAll()
}

// ---------- 本地文件通道 ----------

function dateStamp() {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export async function exportToFile(
  password: string,
  scope: SyncScope,
  win: BrowserWindow | null,
): Promise<SyncFileResult> {
  requirePassword(password)

  const connectionsOnly = scope === 'connections'
  const options = {
    title: connectionsOnly ? '导出连接列表备份' : '导出配置备份',
    defaultPath: path.join(
      app.getPath('documents'),
      `${connectionsOnly ? 'mssh-conns' : 'mssh-sync'}-${dateStamp()}.mssh`,
    ),
    filters: [
      { name: 'mssh 配置备份', extensions: ['mssh'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  }
  const result = win
    ? await dialog.showSaveDialog(win, options)
    : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) {
    return { canceled: true, connections: 0, groups: 0 }
  }

  const data = buildSyncData(scope)
  const envelope = encryptData(data, password)
  const target = result.filePath.endsWith('.mssh') ? result.filePath : `${result.filePath}.mssh`
  await fsp.writeFile(target, JSON.stringify(envelope), 'utf8')
  return {
    canceled: false,
    path: target,
    connections: data.connections.length,
    groups: data.groups.length,
  }
}

export async function importFromFile(
  password: string,
  win: BrowserWindow | null,
): Promise<AllConfig | null> {
  requirePassword(password)

  const options = {
    title: '导入配置备份',
    properties: ['openFile' as const],
    filters: [
      { name: 'mssh 配置备份', extensions: ['mssh'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  }
  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) return null

  let raw: string
  try {
    raw = await fsp.readFile(result.filePaths[0], 'utf8')
  } catch (e) {
    throw new Error(`读取文件失败：${e instanceof Error ? e.message : String(e)}`)
  }
  return applyDecrypted(raw, password)
}

// ---------- WebDAV 通道 ----------

/** 仅编码非 ASCII 与空格，保留已编码的 % 序列 */
function safeUrl(url: string) {
  return url.replace(/[^\x21-\x7E]/g, ch => encodeURIComponent(ch))
}

function stripSlashes(value: string) {
  return value.trim().replace(/^\/+|\/+$/g, '')
}

function dirUrl(webdav: WebDavSettings) {
  const base = webdav.url.trim().replace(/\/+$/, '')
  const dir = stripSlashes(webdav.remoteDir)
  return safeUrl(dir ? `${base}/${dir}` : base)
}

/** 仅连接列表备份使用独立文件名（追加 -conns 后缀），避免覆盖完整备份 */
function scopedFileName(fileName: string, scope: SyncScope) {
  if (scope !== 'connections') return fileName
  const dot = fileName.lastIndexOf('.')
  return dot > 0 ? `${fileName.slice(0, dot)}-conns${fileName.slice(dot)}` : `${fileName}-conns`
}

function fileUrl(webdav: WebDavSettings, scope: SyncScope) {
  return safeUrl(`${dirUrl(webdav)}/${stripSlashes(scopedFileName(webdav.fileName, scope))}`)
}

function authHeaders(webdav: WebDavSettings): Record<string, string> {
  if (!webdav.username && !webdav.password) return {}
  const token = Buffer.from(`${webdav.username}:${webdav.password}`).toString('base64')
  return { Authorization: `Basic ${token}` }
}

function validateWebdav(webdav: WebDavSettings) {
  if (!webdav.url.trim()) throw new Error('请填写 WebDAV 服务器地址')
  if (!/^https?:\/\//i.test(webdav.url.trim())) {
    throw new Error('WebDAV 地址需以 http:// 或 https:// 开头')
  }
  if (!webdav.fileName.trim()) throw new Error('请填写备份文件名')
}

/** 使用 Chromium 网络栈请求 WebDAV（自动遵循系统代理） */
function davRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, method, redirect: 'follow' })
    for (const [key, value] of Object.entries(headers)) req.setHeader(key, value)

    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        req.abort()
      } catch {
        /* noop */
      }
      reject(new Error('请求超时，请检查网络或 WebDAV 地址'))
    }, REQUEST_TIMEOUT)

    req.once('response', resp => {
      const chunks: Buffer[] = []
      resp.on('data', (chunk: Buffer) => chunks.push(chunk))
      resp.on('end', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ status: resp.statusCode, text: Buffer.concat(chunks).toString('utf8') })
      })
      resp.on('error', (err: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new Error(`读取响应失败：${err.message}`))
      })
    })

    req.once('error', err => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`网络请求失败：${err.message}`))
    })

    if (body !== undefined) req.write(body)
    req.end()
  })
}

/** 创建远程目录；已存在时多数 WebDAV 返回 405 */
async function ensureDir(webdav: WebDavSettings) {
  const r = await davRequest(dirUrl(webdav), 'MKCOL', authHeaders(webdav))
  if (r.status === 200 || r.status === 201 || r.status === 405) return
  if (r.status === 401 || r.status === 403) {
    throw new Error('认证失败，请检查用户名/密码')
  }
  if (r.status === 409) throw new Error('远程父目录不存在')
  throw new Error(`创建远程目录失败：HTTP ${r.status}`)
}

export async function testWebDav(webdav: WebDavSettings): Promise<WebDavTestResult> {
  try {
    validateWebdav(webdav)
    const body =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>'
    const r = await davRequest(
      dirUrl(webdav),
      'PROPFIND',
      { ...authHeaders(webdav), Depth: '0', 'Content-Type': 'application/xml' },
      body,
    )
    if (r.status === 200 || r.status === 207) {
      return { ok: true, message: '连接成功', status: r.status }
    }
    if (r.status === 404) {
      return { ok: true, message: '目录不存在，上传时将自动创建', status: r.status }
    }
    if (r.status === 401 || r.status === 403) {
      return { ok: false, message: '认证失败，请检查用户名/密码', status: r.status }
    }
    return { ok: false, message: `服务器返回 HTTP ${r.status}`, status: r.status }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}

export async function uploadWebDav(
  password: string,
  webdav: WebDavSettings,
  scope: SyncScope,
): Promise<SyncUploadResult> {
  requirePassword(password)
  validateWebdav(webdav)

  const data = buildSyncData(scope)
  const json = JSON.stringify(encryptData(data, password))
  await ensureDir(webdav)
  const r = await davRequest(
    fileUrl(webdav, scope),
    'PUT',
    { ...authHeaders(webdav), 'Content-Type': 'application/json' },
    json,
  )
  if (r.status === 401 || r.status === 403) {
    throw new Error('认证失败，请检查用户名/密码')
  }
  if (r.status < 200 || r.status >= 300) throw new Error(`上传失败：HTTP ${r.status}`)
  return {
    connections: data.connections.length,
    groups: data.groups.length,
    bytes: Buffer.byteLength(json),
  }
}

export async function downloadWebDav(
  password: string,
  webdav: WebDavSettings,
  scope: SyncScope,
): Promise<AllConfig> {
  requirePassword(password)
  validateWebdav(webdav)

  const r = await davRequest(fileUrl(webdav, scope), 'GET', authHeaders(webdav))
  if (r.status === 404) throw new Error('云端暂无备份文件，请先上传')
  if (r.status === 401 || r.status === 403) {
    throw new Error('认证失败，请检查用户名/密码')
  }
  if (r.status < 200 || r.status >= 300) throw new Error(`下载失败：HTTP ${r.status}`)
  return applyDecrypted(r.text, password)
}
