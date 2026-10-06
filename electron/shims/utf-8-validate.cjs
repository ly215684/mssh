'use strict'

/**
 * ws 可选原生依赖 utf-8-validate 的桩，原理同 bufferutil.cjs：
 * 求值即抛错 → ws/lib/validation.js 的 try/catch 命中 → 使用内置纯 JS 校验。
 */
throw new Error('utf-8-validate native addon excluded; ws falls back to pure-JS implementation')
