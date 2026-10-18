import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// Share the runtime inventory between packager and regression checks.
// Omitting an imported .mjs file prevents Asc.plugin.init from loading.
export function scribeScriptFiles(dir) {
  return readdirSync(dir)
    .filter(
      name =>
        /\.js$/.test(name) &&
        !/\.(?:spec|test)\.js$/.test(name)
    )
    .sort()
}

// Verify *the distributed output*, not just the list of source files.
// Relative ESM imports must resolve within the package served by OnlyOffice.
export function assertScribePackage(output) {
  const scripts = join(output, 'scripts')
  const names = scribeScriptFiles(scripts)
  if (!names.includes('scribe.js')) throw Error('Scribe entrypoint not packaged')
  const entry = readFileSync(join(output, 'index.html'), 'utf8')
  if (!/type="module"[^>]*src="scripts\/scribe\.js"/.test(entry)) {
    throw Error('Scribe HTML does not load its ESM entrypoint')
  }
  for (const name of names) {
    const source = readFileSync(join(scripts, name), 'utf8')
    for (const [, dependency] of source.matchAll(/\bfrom\s*['"]\.(\/[^'"]+)['"]/g)) {
      // OnlyOffice's plugin static server does not serve .mjs with a JS MIME
      // type. Chromium rejects such imports before Asc.plugin.init runs.
      if (!dependency.endsWith('.js')) {
        throw Error('Unsupported Scribe browser module extension: ' + dependency)
      }
      const target = join(scripts, dependency)
      if (!existsSync(target)) throw Error('Missing Scribe runtime import: ' + name + ' -> ' + dependency)
    }
  }
  for (const file of readdirSync(scripts)) {
    if (/\.(?:test|spec)\.(?:js|mjs)$/.test(file)) {
      throw Error('Test source shipped in Scribe plugin: ' + file)
    }
  }
  return names
}
