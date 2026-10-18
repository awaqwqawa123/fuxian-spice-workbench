// Export a new source snapshot. Never copies the private repository's history.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const source = process.cwd()
const target = resolve(process.argv[2] ?? '')
if (!process.argv[2] || existsSync(target)) throw new Error('Supply a new, nonexistent output directory')
const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 8e6 }).split('\0').filter(Boolean)
const roots = new Set(['.gitignore', '.gitattributes', 'AGENTS.md', 'index.html', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'run-workbench.cmd', 'LICENSE', 'THIRD-PARTY-NOTICES.md'])
const docs = new Set(['drawing-guide.md', 'drawing-patterns.md', 'drawing-acceptance.md', 'drawing-fluidity.md', 'workbench-mcp.md', 'model-assistant-workflow-v026.md', 'noise-analysis.md', 'test-report.md', 'site-sessions.md', 'ai-provider.md', 'net-symbols.md'])
const tests = new Set(['drawing-render-cache.test.ts', 'canvas-render-cache.test.ts', 'probe-marker-visibility.test.ts', 'probes.test.ts', 'probe-wire-deletion.test.ts', 'wire-current-probes.test.ts', 'spice-passives.test.ts', 'waveform-two-axis-zoom.test.ts', 'waveform-middle-pan.test.ts', 'waveform-clipboard.test.ts', 'waveform-expression.test.ts', 'worker-harness.mjs', 'simulate.ts'])
function include(file) {
  return roots.has(file) || /^(src|server|scripts|public|\.github)\//.test(file) ||
    (file.startsWith('docs/') && docs.has(file.slice(5))) ||
    (file.startsWith('docs/open-source/') && file.endsWith('.md')) ||
    (file.startsWith('tests/') && tests.has(file.slice(6)))
}
const files = tracked.filter(include)
mkdirSync(target, { recursive: true })
for (const file of files) {
  const dest = resolve(target, file)
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(resolve(source, file), dest)
}
copyFileSync(resolve(source, 'docs/open-source/README.public.md'), resolve(target, 'README.md'))
const pkg = JSON.parse(readFileSync(resolve(target, 'package.json'), 'utf8'))
pkg.license = 'MIT'
pkg.repository = { type: 'git', url: 'https://github.com/awaqwqawa123/fuxian-spice-workbench.git' }
pkg.bugs = { url: 'https://github.com/awaqwqawa123/fuxian-spice-workbench/issues' }
pkg.scripts.test = 'npm run build && tsx --test --test-concurrency=4 tests/*.test.ts'
delete pkg.scripts['test:mcp']
delete pkg.scripts['model-library:verify']
writeFileSync(resolve(target, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
const lock = JSON.parse(readFileSync(resolve(target, 'package-lock.json'), 'utf8'))
lock.packages[''].license = 'MIT'
writeFileSync(resolve(target, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n')
// The release has no private vendor snapshot. Future local imports stay private.
writeFileSync(resolve(target, '.gitignore'), readFileSync(resolve(source, '.gitignore'), 'utf8') + '\nmodel-library/\n.env\n.env.*\n*.pem\n*.key\n')
writeFileSync(resolve(target, 'PUBLIC-SNAPSHOT.json'), JSON.stringify({
  version: pkg.version,
  exportedAt: new Date().toISOString(),
  includedFiles: files.length + 2,
  excluded: ['private Git history', 'model-library/', 'docs/artifacts/', 'docs/research/', 'docs/assets/', 'verification/', 'local accounts and chats', 'runtime/', 'private regression fixtures'],
  tests: 'A selected regression suite using only synthetic/public inputs; historical private-fixture regressions are not included.',
}, null, 2) + '\n')
console.log(JSON.stringify({ target, files: files.length + 2, tests: tests.size - 2 }))
