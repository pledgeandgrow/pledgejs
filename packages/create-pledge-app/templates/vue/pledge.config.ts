import type { PledgeConfig } from 'pledgestack';

export default {
  rootDir: '.',
  appDir: 'app',
  publicDir: 'public',
  outDir: '.pledge',
  defaultRuntime: 'node',
  framework: 'vue',
  rsc: false,
  tailwind: true,
  output: 'standalone',
} satisfies PledgeConfig;
