#!/usr/bin/env node
// 把当前包发布到 npm registry。
//
// 凭据来源（按优先级）：
//   1. 环境变量 NPM_TOKEN / NODE_AUTH_TOKEN
//   2. 项目内 .npmrc 的 //registry.npmjs.org/:_authToken=（已加入 .gitignore）
//   3. 用户级 ~/.npmrc（npm login 之后的常规位置）
//
// 用法：
//   NPM_TOKEN=npm_xxx node scripts/publish-npm.mjs            # 正式发布
//   node scripts/publish-npm.mjs --dry-run                    # 只打包不发布
//   node scripts/publish-npm.mjs --otp 123456                 # 账号开了 2FA 时
//
// 脚本只做四件事：校验 package.json、构造临时 .npmrc、调用 npm publish、回查 registry。

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const REGISTRY = 'https://registry.npmjs.org/'
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const otpIndex = args.indexOf('--otp')
const otp = otpIndex === -1 ? null : args[otpIndex + 1]

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

function fail(message) {
  console.error(`[publish-npm] ${message}`)
  process.exit(1)
}

// ---- 1. 发布前的硬性检查 ------------------------------------------------
if (!pkg.name) fail('package.json 缺少 name')
if (!pkg.version) fail('package.json 缺少 version')
if (pkg.private === true) fail('package.json 标记了 private: true，不能发布')
if (!pkg.dsh?.bundle?.patch) fail('缺少 dsh.bundle.patch：装上后不会被 bundle 挂载')
if (!existsSync(join(ROOT, pkg.dsh.bundle.patch))) fail(`bundle patch 文件不存在：${pkg.dsh.bundle.patch}`)
if (!pkg.repository?.url) fail('缺少 repository.url：市场收录时会核对包与仓库的对应关系')
if (pkg.publishConfig?.access && pkg.publishConfig.access !== 'public') fail('publishConfig.access 必须为 public，否则无法公开安装')

// ---- 2. 解析 token ------------------------------------------------------
function tokenFromNpmrc(text) {
  const m = text.match(/\/\/registry\.npmjs\.org\/:_authToken\s*=\s*(\S+)/)
  if (!m) return null
  const raw = m[1].replace(/^["']|["']$/g, '')
  const envMatch = raw.match(/^\$\{(\w+)\}$/)
  if (envMatch) return process.env[envMatch[1]] || null
  return raw
}

let token = process.env.NPM_TOKEN || process.env.NODE_AUTH_TOKEN || null
let tokenSource = token ? 'env' : null

if (!token) {
  const projectNpmrc = join(ROOT, '.npmrc')
  if (existsSync(projectNpmrc)) {
    token = tokenFromNpmrc(readFileSync(projectNpmrc, 'utf8'))
    if (token) tokenSource = '.npmrc(project)'
  }
}
if (!token) {
  const userNpmrc = join(process.env.USERPROFILE || process.env.HOME || '', '.npmrc')
  if (existsSync(userNpmrc)) {
    token = tokenFromNpmrc(readFileSync(userNpmrc, 'utf8'))
    if (token) tokenSource = '.npmrc(user)'
  }
}
if (!token && !dryRun) {
  fail(
    '没找到 npm 令牌。三个入口任选其一：\n'
    + '  a) NPM_TOKEN=npm_xxx node scripts/publish-npm.mjs\n'
    + '  b) 在项目根建 .npmrc，写入 //registry.npmjs.org/:_authToken=${NPM_TOKEN}\n'
    + '  c) 先 npm login 一次，再用本脚本',
  )
}

// ---- 3. 用临时 npmrc 发布，不污染用户配置 --------------------------------
const tmp = mkdtempSync(join(tmpdir(), 'npm-publish-'))
const tmpNpmrc = join(tmp, '.npmrc')
writeFileSync(
  tmpNpmrc,
  [
    `registry=${REGISTRY}`,
    token ? `//registry.npmjs.org/:_authToken=${token}` : '',
    '//registry.npmjs.org/:always-auth=true',
    '',
  ].filter(Boolean).join('\n'),
  'utf8',
)

const npmArgs = ['publish', `--registry=${REGISTRY}`, `--userconfig=${tmpNpmrc}`, '--access=public']
if (dryRun) npmArgs.push('--dry-run')
if (otp) npmArgs.push(`--otp=${otp}`)

console.log(`[publish-npm] ${pkg.name}@${pkg.version}`)
console.log(`[publish-npm] 凭据来源: ${tokenSource ?? '(dry-run 无需凭据)'}`)
console.log(`[publish-npm] 命令: npm ${npmArgs.join(' ')}`)

let published = false
try {
  const out = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', npmArgs, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  })
  process.stdout.write(out)
  published = !dryRun
} catch (error) {
  const stderr = String(error.stderr ?? '')
  const stdout = String(error.stdout ?? '')
  // 版本已存在时 npm 返回 E403；换版本号后再发即可，不必重试同一个命令
  if (/EPUBLISHCONFLICT|cannot publish over|previously published/i.test(stderr + stdout)) {
    fail(`${pkg.name}@${pkg.version} 已经发布过，请先提升 version 再发。`)
  }
  fail(`npm publish 失败：\n${stderr || stdout || error.message}`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

// ---- 4. 回查 registry ---------------------------------------------------
if (!published) {
  console.log('[publish-npm] dry-run 结束，未写入 registry。')
  process.exit(0)
}

const url = `${REGISTRY.replace(/\/$/, '')}/${pkg.name.replace('/', '%2f')}`
const res = await fetch(url, { headers: { accept: 'application/json' } })
if (!res.ok) fail(`发布后回查失败：HTTP ${res.status} ${url}`)
const meta = await res.json()
const latest = meta['dist-tags']?.latest
const versions = Object.keys(meta.versions ?? {})
console.log(`[publish-npm] registry 已收录：${pkg.name}`)
console.log(`[publish-npm] latest=${latest}  版本数=${versions.length}`)
console.log(`[publish-npm] tarball=${meta.versions?.[pkg.version]?.dist?.tarball ?? '(未找到)'}`)
if (!versions.includes(pkg.version)) fail(`registry 里没有 ${pkg.version}，发布可能未生效`)
console.log('[publish-npm] 完成。')
