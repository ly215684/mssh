#!/usr/bin/env node
/**
 * 发布脚本：更新版本号 → 提交 → 打 tag → 推送远端
 *
 * 用法：
 *   pnpm release            # patch +1 (0.0.x)
 *   pnpm release minor      # minor +1 (0.x.0)
 *   pnpm release major      # major +1 (x.0.0)
 *   pnpm release 1.2.3      # 指定版本号
 *
 * 触发 GitHub Actions：推送 v* tag 后自动三平台打包并上传 Release
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { execSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkgPath = path.join(root, 'package.json')

const die = msg => {
  console.error(`[release] ${msg}`)
  process.exit(1)
}

const run = (cmd, opts = {}) => {
  try {
    return execSync(cmd, { cwd: root, stdio: 'pipe', encoding: 'utf-8', ...opts })
  } catch (e) {
    // git 可能将失败原因写到 stdout 或 stderr，两者都要展示
    const detail = [e.stdout, e.stderr].map(s => (s || '').toString().trim()).filter(Boolean).join('\n')
    die(`命令执行失败: ${cmd}\n${detail || e.message}`)
  }
}

const canRun = cmd => {
  try {
    execSync(cmd, { cwd: root, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

// ---------- git 环境预检查 ----------
if (!canRun('git rev-parse --git-dir')) {
  die('当前目录不是 git 仓库。请先执行:\n  git init && git remote add origin <仓库地址>')
}
if (!canRun('git remote get-url origin')) {
  die('尚未配置远端 origin。请先执行:\n  git remote add origin <仓库地址>')
}

// ---------- 参数解析 ----------
const arg = process.argv[2] ?? 'patch'
const bump = (version, type) => {
  const parts = version.replace(/^v/, '').split('.').map(Number)
  if (parts.length !== 3 || parts.some(Number.isNaN)) return null
  if (type === 'major') return `${parts[0] + 1}.0.0`
  if (type === 'minor') return `${parts[0]}.${parts[1] + 1}.0`
  if (type === 'patch') return `${parts[0]}.${parts[1]}.${parts[2] + 1}`
  return type.replace(/^v/, '')
}

// ---------- 预检查 ----------
const dirty = run('git status --porcelain')
if (dirty) die('工作区存在未提交的更改，请先提交或暂存：\n' + dirty)

const branch = run('git rev-parse --abbrev-ref HEAD')

const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
const next = bump(pkg.version, arg)
if (!next || !/^\d+\.\d+\.\d+$/.test(next)) die(`无效的版本参数: "${arg}"（可用 patch/minor/major 或 x.y.z）`)

const tag = `v${next}`
if (run(`git tag -l ${tag}`)) die(`标签 ${tag} 已存在，请换一个版本号`)

// ---------- 更新版本号 ----------
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8')
console.log(`[release] ${pkg.version} -> ${next}  (branch: ${branch})`)

// ---------- 提交 + 打 tag + 推送 ----------
try {
  run(`git add package.json`)
  run(`git commit -m "chore(release): ${tag}"`)
  run(`git tag -a ${tag} -m "Release ${tag}"`)
  run(`git push origin ${branch} ${tag}`)
} catch (e) {
  die(`git 操作失败：${e.message}\n可手动回滚版本号后重试`)
}

console.log(`[release] 已推送 ${branch} 与标签 ${tag}，GitHub Actions 将自动构建三平台安装包`)
console.log(`[release] 查看进度: gh run watch 或仓库 Actions 页面`)
