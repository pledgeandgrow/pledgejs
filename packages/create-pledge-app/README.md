# create-pledge-app

Scaffolding CLI for new PledgeStack applications.

## Usage

```bash
npx create-pledge-app my-app
# or
pnpm create pledge-app my-app
```

Also available through the main CLI as `pledge create <name>`.

### Flags

| Flag | Description |
|---|---|
| `--template <name>` / `-t` | Template to scaffold (see below) |
| `--framework <name>` / `-f` | UI framework: `react`, `vue`, `solid`, `svelte` |
| `--install` / `--no-install` | Skip the "install dependencies?" prompt |

```bash
npx create-pledge-app my-app --template blog --framework react --no-install
```

## Frameworks

PledgeStack supports four UI frameworks via pluggable renderer adapters:

- **React** — Default, with RSC support
- **Vue** — Vue 3 with `<script setup>`
- **Solid** — SolidJS with fine-grained reactivity
- **Svelte** — Svelte 5 with runes

Select during scaffolding or pass `--framework vue`:

```bash
npx create-pledge-app my-app --framework vue
```

Non-React frameworks currently ship a single `default` starter each (the
`templates/vue`, `templates/solid`, `templates/svelte` directories). Picking a
React-only content template (e.g. `--template blog --framework vue`) falls back
to the framework's `default` starter with a warning, rather than copying React
JSX into a non-React project.

## Templates

- **pledge** — Full-stack React + Rust backend: `server/` directory with
  `#[route]`-annotated `.rs` handlers and `.psx` support (requires the
  PledgePack binary; sets `framework: 'pledge'` in `pledge.config.ts`)
- **default** — Full-featured starter with blog, features page, and dark theme
- **blog** — Blog with static generation and dynamic routes
- **api** — REST API with CRUD routes
- **saas** — SaaS landing page with pricing, features, and testimonials
- **portfolio** — Personal portfolio with projects showcase and contact
- **dashboard** — Admin dashboard with sidebar, stats, charts, and data table
- **ecommerce** — Product listing with filters, cart, and checkout UI

All templates except `pledge` are React-only today; the `vue`, `solid`, and
`svelte` framework starters serve as their `default` equivalents.

## What gets generated

Each scaffold writes:

- `app/` — file-based routes from the chosen template
- `pledge.config.ts` — framework config
- `package.json` — with `pledgestack` + `pledgepack` versions resolved from the
  npm registry (`latest` dist-tag when offline)
- `tsconfig.json` — per-framework JSX settings
- `.gitignore`, `pnpm-workspace.yaml` — the workspace file pre-approves
  `pledgepack`/`esbuild` build scripts (`allowBuilds` for pnpm 11,
  `onlyBuiltDependencies` for pnpm 10) so the native binary postinstall works
  without a manual `approve-builds` step

## Development

```bash
pnpm build   # Compile TypeScript
pnpm dev     # Watch mode
```
