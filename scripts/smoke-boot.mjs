#!/usr/bin/env node
// Boot-smoke: mount the freshly built plugin into a scratch dsh profile
// (bundle patch + packed tarball) and boot it with the real dsh CLI.
//
//   1. npm pack the repo → tarball
//   2. scratch $DSH_HOME/profiles/smoke with the plugin as a file: dep and a
//      dsh.profile.bundles entry (same shape as the user's real profiles)
//   3. pnpm install
//   4. `dsh --profile smoke --dump-config` must compose the plugin into the
//      tree, WITH the scratch profile's `mode: once` override merged into its
//      row config (mount + config-layer proof), and its
//      @aiwayds/dsh-jev-core dependency installed alongside
//   5. a real boot under a timeout must load the plugin tree without a
//      loader error (a healthy boot is silent and survives to the kill
//      signal; a broken plugin dies within ~1s with the loader error)
//   6. `dsh plugin --profile smoke remove <pkg>` must reconcile the profile
//      back to stock — the post-removal dump no longer contains the entry
//
// Exit 0 = mounted, configured, boots clean, and removal restores the stock
// tree. Temp dir is kept and printed on failure, removed on success.
//
// dsh-agent-dispatch note: the shipped plugin is `mode: off`, so the scratch
// profile flips it to `once` — with no jev key in the runner environment
// `apply()` then takes its silent leg, which is the jev-optional contract
// proved on the real host. The smoke proves the plugin LOADS and APPLIES
// (a broken import/inject/compose dies with a loader error), which is exactly
// the gate this CI needs; the pre-step handler itself is covered by the
// fake-context tests, since a real turn needs a model and a key.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'))
const ownName = pkg.name // @aiwayds/dsh-agent-dispatch

const work = mkdtempSync(path.join(tmpdir(), 'dsh-agent-dispatch-smoke-'))
const home = path.join(work, 'dsh-home')
const profile = path.join(home, 'profiles', 'smoke')
mkdirSync(profile, { recursive: true })

function fail(message, output = '') {
  console.error(`smoke-boot: FAIL — ${message}`)
  if (output) console.error(output.split('\n').slice(0, 30).join('\n'))
  console.error(`smoke-boot: scratch kept at ${work}`)
  process.exit(1)
}

const pack = spawnSync('npm', ['pack', '--pack-destination', work], { cwd: repoRoot, encoding: 'utf8' })
if (pack.status !== 0 || pack.error) fail('npm pack failed', `${pack.stdout}\n${pack.stderr}`)
const tarball = path.join(work, pack.stdout.trim().split('\n').at(-1))

writeFileSync(path.join(profile, 'cordis.yml'), '# dsh profile root — empty; the tree is composed from the bundle patches\n[]\n')
// The scratch profile flips the plugin out of its shipped `mode: off` so the
// boot exercises the CONFIG branch too: `apply()` resolves the row config,
// reaches the jev-optional key check, and prints its one boot line. With no key
// in the runner environment that is the "stays silent" line — the exact
// behavior the jev-optional contract requires, proved on the real host.
writeFileSync(path.join(profile, 'cordis.patch.yml'), [
  '# scratch smoke profile: override the bundle patch to exercise the config path',
  `- id: dsh-agent-dispatch`,
  '  config:',
  '    mode: once',
  '',
].join('\n'))
writeFileSync(path.join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
writeFileSync(path.join(profile, 'package.json'), JSON.stringify({
  name: 'dsh-profile-smoke',
  private: true,
  dependencies: {
    [ownName]: `file:${tarball}`,
  },
  dsh: {
    profile: {
      bundles: [
        '@deepseek-ai/dsh-base',
        ownName,
      ],
    },
  },
}, null, 2) + '\n')

const install = spawnSync('pnpm', ['install'], { cwd: profile, encoding: 'utf8' })
if (install.status !== 0 || install.error) fail('pnpm install in the scratch profile failed', `${install.stdout}\n${install.stderr}`)

const dshEnv = { ...process.env, DSH_HOME: home }

// Phase 1 — mount proof: the composed tree must include the plugin.
const dump = spawnSync('dsh', ['--profile', 'smoke', '--dump-config'], { cwd: profile, encoding: 'utf8', env: dshEnv })
if (dump.status !== 0 || dump.error) fail('dsh --dump-config failed on the scratch profile', `${dump.stdout}\n${dump.stderr}`)
if (!dump.stdout.includes(ownName)) {
  fail(`the composed profile tree does not contain ${ownName} — the bundle patch insert is broken`, dump.stdout)
}
// The scratch profile's `mode: once` override must survive the merge: the host
// accepted the row config this plugin documents, and the transitive
// @aiwayds/dsh-jev-core dependency resolved inside the profile closure.
if (!dump.stdout.includes('mode: once')) {
  fail('the profile config override did not reach the plugin row — the host rejected or dropped its config', dump.stdout)
}
if (!existsSync(path.join(profile, 'node_modules', '@aiwayds', 'dsh-jev-core'))) {
  fail('the @aiwayds/dsh-jev-core dependency did not install into the scratch profile')
}

// Phase 2 — boot proof: the plugin tree must LOAD without a loader error.
const bootSeconds = 25
const boot = spawnSync('dsh', ['--profile', 'smoke'], {
  cwd: profile,
  encoding: 'utf8',
  timeout: bootSeconds * 1000,
  killSignal: 'SIGKILL',
  env: dshEnv,
})
const output = `${boot.stdout ?? ''}\n${boot.stderr ?? ''}`
const loaderErrors = [
  /plugin tree failed to load/,
  /failed to apply loader entry/,
  /cannot get property ".*" without inject/,
  /cannot get required service/,
  /Cannot find (package|module)/,
]
const hit = loaderErrors.filter((re) => re.test(output))
if (hit.length > 0) {
  fail('the real host failed to load the plugin tree:', output.split('\n').filter((line) => hit.some((re) => re.test(line)) || /Error/.test(line)).slice(0, 15).join('\n'))
}
if (boot.signal !== 'SIGKILL' && boot.status !== 0) {
  fail(`dsh exited early with code ${boot.status} and no loader error — unexpected`, output)
}

// Phase 3 — uninstall leg: removal must reconcile the profile tree back to stock.
const remove = spawnSync('dsh', ['plugin', '--profile', 'smoke', 'remove', ownName], { cwd: profile, encoding: 'utf8', env: dshEnv })
if (remove.status !== 0 || remove.error) fail('dsh plugin remove failed', `${remove.stdout}\n${remove.stderr}`)
const dumpAfter = spawnSync('dsh', ['--profile', 'smoke', '--dump-config'], { cwd: profile, encoding: 'utf8', env: dshEnv })
if (dumpAfter.status !== 0 || dumpAfter.error) fail('dsh --dump-config failed after removal', `${dumpAfter.stdout}\n${dumpAfter.stderr}`)
if (dumpAfter.stdout.includes('dsh-agent-dispatch')) {
  fail('the composed tree still contains the plugin entry after removal', dumpAfter.stdout)
}

console.log(`smoke-boot: PASS — ${ownName} composed into the scratch profile tree and booted clean in real dsh (${boot.signal === 'SIGKILL' ? `survived ${bootSeconds}s boot window` : `exited ${boot.status}`}); removal restored the stock tree`)
rmSync(work, { recursive: true, force: true })
