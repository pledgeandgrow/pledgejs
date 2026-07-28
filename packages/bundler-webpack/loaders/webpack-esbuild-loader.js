// Webpack loader for .ts and .tsx files using esbuild.
// This file is CommonJS because webpack loaders are require()'d.

const { transform } = require('esbuild');

module.exports = function webpackEsbuildLoader(source) {
  const callback = this.async();
  const resourcePath = this.resourcePath;
  const ext = resourcePath.endsWith('.tsx') ? 'tsx' : resourcePath.endsWith('.jsx') ? 'jsx' : 'ts';
  const isDev = this.getOptions().isDev ?? false;

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
