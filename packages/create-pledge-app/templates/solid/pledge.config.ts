import type { PledgeConfig } from 'pledgestack';

export default {
  rootDir: '.',
  appDir: 'app',
  publicDir: 'public',
  outDir: '.pledge',
  defaultRuntime: 'node',
  framework: 'solid',
  rsc: false,
  tailwind: true,
  output: 'standalone',
} satisfies PledgeConfig;
