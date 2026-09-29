// Loads Model.js the way QML does: as a plain script whose top-level
// functions become the library's API. No exports needed, so the same file
// works in the shell and here. Coverage is attributed to Model.js itself.
import fs from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

export const pluginDir = fileURLToPath(new URL('../../', import.meta.url))
const file = pluginDir + 'Model.js'

export function loadModel() {
  const ctx = vm.createContext({})
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file })
  return ctx
}
