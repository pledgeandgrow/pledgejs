// Side-effect imports — each renderer adapter self-registers into the
// globalThis renderer registry on import (getRendererRegistry().register()).
// Bundled into the CLI via the build.mjs alias table so `initRenderer`
// resolves every adapter from this bundle instead of requiring the app to
// install unpublished `pledgestack-renderer-*` packages.
//
// Non-React adapters deliberately avoid static imports of their frameworks
// (vue/svelte/solid emit framework imports only into generated client code),
// so eagerly importing them here adds no hard framework dependencies.
import 'pledgestack-renderer-react';
import 'pledgestack-renderer-vue';
import 'pledgestack-renderer-solid';
import 'pledgestack-renderer-svelte';
