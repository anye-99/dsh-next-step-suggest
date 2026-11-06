#!/usr/bin/env node
// CI 冒烟测试：只依赖 Node 内建模块，不 import 宿主端 lib/index.js。
//
// 为什么不跑 scripts/test-host.mjs：它静态 import 了 @deepseek-ai/dsh-llm，
// 而该包的 peerDependencies 又牵出 dsh-attachment / dsh-brand / dsh-invariants /
// dsh-timeout / cordis 一整串宿主运行时。在干净机器上装不齐，会让发布流水线
// 因为「装不到宿主的半条依赖链」而变红。宿主行为用 test-host.mjs 在本地验，
// 这里验的是「发布出去的那份产物是否自洽」。

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (p) => readFileSync(join(ROOT, p), 'utf8')
const pkg = JSON.parse(read('package.json'))

// ---- 1. 发布必需字段 ----------------------------------------------------
assert.ok(pkg.name, 'name 缺失')
assert.match(pkg.version, /^\d+\.\d+\.\d+/, `version 不合规：${pkg.version}`)
assert.notEqual(pkg.private, true, 'private 不能为 true')
assert.ok(pkg.repository?.url, 'repository.url 缺失：市场靠它把 npm 包与仓库对上')
assert.ok(/github\.com\/anye-99\/dsh-next-step-suggest/.test(pkg.repository.url), 'repository 未回指本仓库')
assert.equal(pkg.publishConfig?.access, 'public', 'publishConfig.access 必须为 public')
console.log('PASS 发布字段完整')

// ---- 2. bundle manifest 与实际文件一致 ----------------------------------
assert.ok(pkg.dsh?.bundle?.patch, '缺少 dsh.bundle.patch：装上后不会被挂载')
const patchPath = join(ROOT, pkg.dsh.bundle.patch)
assert.ok(existsSync(patchPath), `patch 文件不存在：${pkg.dsh.bundle.patch}`)
const patch = read(pkg.dsh.bundle.patch)
assert.ok(/insert:/.test(patch), 'cordis.patch.yml 缺少 insert 段')
assert.ok(patch.includes(pkg.name), `patch 里没有挂载 ${pkg.name}`)
console.log('PASS bundle patch 指向本包')

// ---- 3. 入口与 files 白名单 ---------------------------------------------
for (const key of ['main']) {
  const p = pkg[key]
  assert.ok(p, `${key} 缺失`)
  assert.ok(existsSync(join(ROOT, p)), `${key} 指向不存在的文件：${p}`)
}
for (const [sub, target] of Object.entries(pkg.exports ?? {})) {
  if (sub === './package.json') continue
  assert.ok(existsSync(join(ROOT, target)), `exports["${sub}"] 指向不存在的文件：${target}`)
}
for (const f of pkg.files ?? []) {
  assert.ok(existsSync(join(ROOT, f)), `files 列了不存在的路径：${f}`)
}
// exports 里的入口必须在打包白名单内，否则用户装到的包缺文件
const covered = (target) => (pkg.files ?? []).some((f) => target === f || target.startsWith(`${f}/`) || target.startsWith('./' + f))
for (const [sub, target] of Object.entries(pkg.exports ?? {})) {
  if (sub === './package.json') continue
  assert.ok(covered(target.replace(/^\.\//, '')), `exports["${sub}"] 的 ${target} 不在 files 白名单里`)
}
console.log('PASS 入口与 files 白名单自洽')

// ---- 4. 不把备份/日志打进包 ---------------------------------------------
const banned = []
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) walk(join(dir, entry.name))
    else if (/\.bak-|\.log$/.test(entry.name)) banned.push(join(dir, entry.name).slice(ROOT.length + 1))
  }
}
for (const f of pkg.files ?? []) {
  const abs = join(ROOT, f)
  if (!existsSync(abs)) continue
  if (statSync(abs).isDirectory()) walk(abs)
  else if (/\.bak-|\.log$/.test(abs)) banned.push(f)
}
assert.ok(!banned.length, `files 里混入备份文件：${banned.join(', ')}`)
console.log('PASS 无备份文件混入')

// ---- 5. 版本号单一来源 --------------------------------------------------
const host = read('lib/index.js')
assert.ok(/const VERSION = /.test(host), 'lib/index.js 应通过 VERSION 常量读取版本')
assert.ok(!new RegExp(pkg.version.replace(/\./g, '\\.') + '["\']').test(host), 'lib/index.js 仍硬编码版本号')
console.log('PASS 版本号只有 package.json 一个来源')

console.log('\nALL MANIFEST TESTS PASSED')
