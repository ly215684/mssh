'use strict'

/**
 * ws 可选原生依赖 bufferutil 的桩。
 * 原模块是需按 Electron ABI 编译的原生绑定；ESM 打包时不可解析的 require
 * 会被提升为静态 import（try/catch 无法兜住）导致启动即崩。
 * 此处保持 CJS 可解析且求值即抛错，使 ws/lib/buffer-util.js 的 try/catch
 * 正常命中并回退到内置纯 JS 实现（buffer-util-fallback）。
 */
throw new Error('bufferutil native addon excluded; ws falls back to pure-JS implementation')
