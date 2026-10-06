import { defineConfig } from 'vite'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import electron from 'vite-plugin-electron/simple'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import monacoEditorPlugin from 'vite-plugin-monaco-editor'

// vite-plugin-monaco-editor 是 CJS 包，ESM 导入时函数挂在 .default 上
const monacoPlugin = (monacoEditorPlugin as unknown as { default: typeof monacoEditorPlugin }).default ?? monacoEditorPlugin

const pkg: { version: string } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf-8'),
)

// https://vitejs.dev/config/
export default defineConfig({
  define: {
    // 注入应用版本号（StatusBar 显示 / 关于信息）
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  // noVNC 1.7 的模块含顶层 await（WebCodecs H264 能力探测），需 es2022 target；
  // Electron 30 内置 Chromium 124，原生支持 TLA
  build: {
    target: 'es2022',
  },
  optimizeDeps: {
    esbuildOptions: {
      target: 'es2022',
    },
  },
  plugins: [
    tailwindcss(),
    react(),
    monacoPlugin({}),
    electron({
      main: {
        entry: 'electron/main.ts',
        vite: {
          resolve: {
            alias: {
              // ssh2 可选原生依赖 cpu-features 的 JS 桩（避免打包原生绑定）
              'cpu-features': path.resolve(__dirname, 'electron/shims/cpu-features.cjs'),
              // ws 可选原生依赖桩（求值抛错触发 ws 内置纯 JS 回退；ESM 静态 import 无法 try/catch）
              bufferutil: path.resolve(__dirname, 'electron/shims/bufferutil.cjs'),
              'utf-8-validate': path.resolve(__dirname, 'electron/shims/utf-8-validate.cjs'),
            },
          },
          build: {
            rollupOptions: {
              // .node 原生模块保留为运行时 require（ssh2 内部 try/catch 静默回退）
              external: [/\.node$/],
              output: {
                // ESM 输出中依赖（ssh2 等）引用 __dirname，注入全局 shim
                banner:
                  "import { dirname as __pd } from 'node:path'; import { fileURLToPath as __fu } from 'node:url'; var __dirname = __pd(__fu(import.meta.url));",
              },
            },
          },
        },
      },
      preload: {
        input: path.join(__dirname, 'electron/preload.ts'),
        vite: {
          build: {
            rollupOptions: {
              external: ['electron'],
              output: {
                // CJS preload 最为稳妥（.mjs + require 的组合会导致 preload 加载失败）
                format: 'cjs',
                entryFileNames: 'preload.cjs',
              },
            },
          },
        },
      },
      renderer: process.env.NODE_ENV === 'test' ? undefined : {},
    }),
  ],
})
