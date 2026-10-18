import { readdirSync } from 'node:fs'

// Share the runtime inventory between packager and regression checks.
// Omitting an imported .mjs file prevents Asc.plugin.init from loading.
export function scribeScriptFiles(dir) {
  return readdirSync(dir)
    .filter(
      name =>
        /\.(?:js|mjs)$/.test(name) &&
        !/\.(?:spec|test)\.(?:js|mjs)$/.test(name)
    )
    .sort()
}
