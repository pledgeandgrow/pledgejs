// Webpack loader for .ts and .tsx files using esbuild.
// This file is CommonJS because webpack loaders are require()'d.

const { transform } = require('esbuild');

module.exports = function webpackEsbuildLoader(source) {
  const callback = this.async();
  const resourcePath = this.resourcePath;
  const options = this.getOptions();
  // `options.loader` lets a rule force the esbuild loader (e.g. `tsx` for .psx,
  // whose extension would otherwise select `ts` and reject JSX).
  const ext = options.loader ?? (resourcePath.endsWith('.tsx') ? 'tsx' : resourcePath.endsWith('.jsx') ? 'jsx' : 'ts');
  const isDev = options.isDev ?? false;

  transform(source, {
    loader: ext,
    target: 'es2022',
    format: 'esm',
    sourcemap: 'inline',
    jsx: 'automatic',
    jsxImportSource: 'react',
    define: {
      'process.env.NODE_ENV': isDev ? '"development"' : '"production"',
    },
  })
    .then((result) => callback(null, result.code))
    .catch((err) => callback(err));
};
