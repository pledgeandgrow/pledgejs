# create-pledge-app

Scaffolding CLI for new PledgeStack applications.

## Usage

```bash
npx create-pledge-app my-app
# or
pnpm create pledgestack my-app
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

## Templates

- **default** — Full-featured starter with blog, features page, and dark theme
- **blog** — Blog with static generation and dynamic routes
- **api** — REST API with CRUD routes
- **saas** — SaaS landing page with pricing, features, and testimonials
- **portfolio** — Personal portfolio with projects showcase and contact
- **dashboard** — Admin dashboard with sidebar, stats, charts, and data table
- **ecommerce** — Product listing with filters, cart, and checkout UI

## Development

```bash
pnpm build   # Compile TypeScript
pnpm dev     # Watch mode
```
