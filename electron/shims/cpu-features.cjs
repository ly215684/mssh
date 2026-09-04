'use strict'

/**
 * ssh2 可选原生依赖 cpu-features 的 JS 桩。
 * 原模块需要本地编译的原生绑定（build/Release/cpufeatures.node），
 * 打包环境无法保证存在；此处返回空特性集，ssh2 将走纯 JS 路径。
 */
module.exports = function cpuFeatures() {
  return {}
}
