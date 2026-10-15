import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle('@deepseek-ai/dsh-experimental-xiaozhi', ['lib/types/index.js'], {
  hostPhase: true,
  companions: [{
    // The exit-intent tool is a preset-scoped plugin instantiated through the
    // `./exit-tool` subpath export, so it ships as its own Node artifact beside
    // the gateway bundle. Workspace imports stay external: the artifact runs
    // from a real install where the plugin package's dependencies are linked.
    name: '@deepseek-ai/dsh-experimental-xiaozhi/exit-tool',
    entry: ['lib/types/exit-tool.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: { neverBundle: () => true },
  }],
})
