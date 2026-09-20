// Registers all bundled renderer adapters into the globalThis registry so
// `initRenderer` finds them without per-app renderer packages installed.
import './renderers';

export * from 'pledgestack-server';
