/**
 * Build config for the jev-suggest plugin (host + client halves).
 *
 * Produces two artifacts:
 * 1. lib/index.js + lib/types/ — Node half (host plugin: session collectors,
 *    the two-step suggestion pipeline, the browser-facing routes).
 * 2. lib/client.js — Browser half: CJS closure-factory wrapped in
 *    `window.__ModuleLoader__.load({ id, factory: (require) => {...} })`,
 *    with platform modules as externals resolved by the shell's module table.
 *
 * The browser half uses factory closures only — no class private fields
 * (the oxc CJS pipeline panics on `#x`).
 */
import { defineConfig } from 'tsdown'

const PLATFORM_EXTERNALS = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
] as const

const isExternal = (s: string): boolean =>
  PLATFORM_EXTERNALS.some(p => s === p || s.startsWith(p + '/'))

const BANNER = `window.__ModuleLoader__.load({ id: "@runzhi214/dsh-jev-suggest", factory: (require) => {`
const FOOTER = 'return module.exports; } });'
const INTRO = 'var module = { exports: {} }; var exports = module.exports;'

export default defineConfig([
  {
    name: 'node',
    entry: ['src/index.ts'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: true,
    clean: true,
  },
  {
    name: 'client',
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    sourcemap: true,
    external: isExternal,
    outputOptions: {
      entryFileNames: 'client.js',
      banner: BANNER,
      footer: FOOTER,
      intro: INTRO,
    },
  },
])
