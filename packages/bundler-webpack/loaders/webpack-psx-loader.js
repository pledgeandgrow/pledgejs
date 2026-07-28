// Webpack loader for .psx and .ps files.
// Delegates to PledgeStack's transform pipeline (transformPSX).
// This file is CommonJS because webpack loaders are require()'d.

const { transformPSX } = require('pledgestack-core');
const { basename, extname } = require('node:path');

module.exports = function webpackPsxLoader(source) {
  const callback = this.async();
  const resourcePath = this.resourcePath;
  const ext = extname(resourcePath);
  const moduleName = basename(resourcePath, ext);
  const format = ext === '.ps' ? 'ps' : 'psx';

  try {
    const result = transformPSX(source, {
      moduleName,
      compileRust: true,
      addonPath: `./${moduleName}.node`,
      format,
    });

    const code = result.tsx ?? result.napiWrapper ?? '';
    callback(null, code);
  } catch (err) {
    callback(err);
  }
};
