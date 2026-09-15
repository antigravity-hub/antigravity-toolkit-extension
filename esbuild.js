const esbuild = require('esbuild');

const isWatch = process.argv.includes('--watch');

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: !isWatch,
    sourcemap: isWatch,
    sourcesContent: false,
    platform: 'node',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    logLevel: 'info',
  });

  if (isWatch) {
    console.log('[esbuild] Watching for changes...');
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
    console.log('[esbuild] Build finished successfully.');
    process.exit(0);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
