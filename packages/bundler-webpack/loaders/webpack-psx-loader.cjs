// Webpack loader for .psx and .ps files.
// Delegates to PledgeStack's shared compile pipeline (loadPSXModule): it parses
// the file, compiles the Rust addon with cargo, writes the NAPI wrapper (or the
// fallback stub when cargo is unavailable) and returns the module source.
// This file is CommonJS because webpack loaders are require()'d.
//
// Options (all optional): { config (PledgeConfig), isDev, build }.

module.exports = function webpackPsxLoader() {
  const callback = this.async();
  const resourcePath = this.resourcePath;
  const options = (typeof this.getOptions === 'function' ? this.getOptions() : this.query) || {};
  const isDev = options.isDev ?? this.mode !== 'production';

  // pledgestack-core is ESM-only (its package.json `exports` has no `require`
  // condition), so it must be loaded with a dynamic import() — a plain
  // require('pledgestack-core') throws ERR_PACKAGE_PATH_NOT_EXPORTED.
  import('pledgestack-core')
    .then(({ loadPSXModule }) =>
      loadPSXModule(resourcePath, {
        isDev,
        projectRoot: options.config?.rootDir ?? options.rootDir ?? this.rootContext,
        cargoConfig: options.config?.cargo ?? options.cargo,
        build: options.build,
      }),
    )
    .then((code) => callback(null, code))
    .catch((err) => callback(err));
};
