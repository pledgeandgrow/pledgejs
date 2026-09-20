# pledgestack-og

Dynamic OpenGraph image generation for PledgeStack.

## Usage

```typescript
// app/api/og/route.ts
import { ImageResponse } from 'pledgestack-og';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const title = searchParams.get('title') ?? 'PledgeStack';

  return new ImageResponse(
    (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        width: '100%',
        height: '100%',
        backgroundColor: '#0a0a0a',
        color: '#fff',
        fontSize: 60,
        fontWeight: 700,
      }}>
        {title}
      </div>
    ),
    { width: 1200, height: 630 }
  );
}
```

## API

- `ImageResponse` — `Response` subclass that carries the serialized JSX tree. The PledgeStack server renders it to a PNG: a built-in flexbox subset lays the tree out as SVG, and the native `rust-og-renderer` addon or the optional `sharp` package rasterizes it (`pnpm add sharp`). With neither installed the server answers `501` with an actionable message. Function components are called with their props (no hooks); only inline `data:` images are drawn; custom font bytes are not embedded.
- `ogMetaTags(options)` — Generate OG and Twitter Card meta tag strings
