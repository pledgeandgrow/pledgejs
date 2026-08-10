# PledgePack (Legacy Placeholder)

> **Note:** PledgePack is now installed from npm as `pledgepack@^0.2.8`. This directory is a legacy placeholder excluded from the pnpm workspace. It is not used or maintained.

## Actual PledgePack

PledgePack is a Rust+Zig-based build compiler and bundler published on npm:

```bash
npm install pledgepack
```

CLI command: `pledge`

```bash
pledge dev      # Dev server with HMR
pledge build    # Production build
pledge serve    # Serve production build (port 4000)
pledge test     # Run tests
pledge analyze  # Bundle analyzer
pledge bench    # Benchmark builds
```

- **Repository:** `https://github.com/pledgeandgrow/pledgerepo`
- **npm:** `pledgepack` (currently `0.2.8`)
- **Binary:** Native Rust binary distributed via GitHub Releases + postinstall download
