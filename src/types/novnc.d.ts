/** @novnc/novnc 的最小类型声明（官方包不含 d.ts），仅覆盖本应用用到的 API 面 */
declare module '@novnc/novnc' {
  export interface RfbCredentials {
    username?: string
    password?: string
    target?: string
  }

  export interface RfbOptions {
    credentials?: RfbCredentials
    shared?: boolean
    repeaterID?: string
    wsProtocols?: string | string[]
  }

  export interface RfbEventMap {
    connect: Event
    disconnect: CustomEvent<{ clean: boolean }>
    credentialsrequired: CustomEvent<{ types: string[] }>
    securityfailure: CustomEvent<{ status: number; reason: string }>
    clipboard: CustomEvent<{ text: string }>
    bell: Event
    desktopname: CustomEvent<{ name: string }>
    capabilities: CustomEvent<{ capabilities: unknown }>
  }

  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: RfbOptions)
    get viewOnly(): boolean
    set viewOnly(v: boolean)
    get focusOnClick(): boolean
    set focusOnClick(v: boolean)
    get clipViewport(): boolean
    set clipViewport(v: boolean)
    get scaleViewport(): boolean
    set scaleViewport(v: boolean)
    get showDotCursor(): boolean
    set showDotCursor(v: boolean)
    get background(): string
    set background(v: string)
    get qualityLevel(): number
    set qualityLevel(v: number)
    get compressionLevel(): number
    set compressionLevel(v: number)
    disconnect(): void
    sendCredentials(credentials: RfbCredentials): void
    sendKey(keysym: number, code: string | null, down?: boolean): void
    sendCtrlAltDel(): void
    clipboardPasteFrom(text: string): void
    focus(options?: FocusOptions): void
    blur(): void
    addEventListener<K extends keyof RfbEventMap>(
      type: K,
      listener: (ev: RfbEventMap[K]) => void,
      options?: boolean | AddEventListenerOptions,
    ): void
    removeEventListener<K extends keyof RfbEventMap>(
      type: K,
      listener: (ev: RfbEventMap[K]) => void,
      options?: boolean | EventListenerOptions,
    ): void
  }
}
