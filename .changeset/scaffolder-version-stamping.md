---
"create-pledge-app": patch
---

Scaffolder fixes: resolve `pledgestack`/`pledgepack` versions from npm at
scaffold time (release-channel aware) instead of stale template pins, stamp
the generated health route with the resolved framework version, emit both
pnpm build-script approval formats (`allowBuilds` + `onlyBuiltDependencies`)
in `pnpm-workspace.yaml`, and drop the stale `templates/pledge/package.json`
that contradicted the generated manifest.
