import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

interface CreateOptions {
  template?: 'default' | 'blank' | 'blog' | 'dashboard';
  typescript?: boolean;
  tailwind?: boolean;
  packageManager?: 'pnpm' | 'npm' | 'yarn';
}

const DEFAULT_TEMPLATE = {
  'pledge.config.ts': `import { defineConfig } from 'pledgestack';

export default defineConfig({
  appDir: 'app',
  publicDir: 'public',
  outDir: '.pledge',
  defaultRuntime: 'node',
  rsc: true,
  tailwind: true,
});
`,
  'tsconfig.json': `{
  "extends": "./node_modules/pledgestack/tsconfig-base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true
  },
  "include": ["app/**/*", "pledge.config.ts"]
}
`,
  'package.json': (name: string) => `{
  "name": "${name}",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "pledge dev",
    "build": "pledge build",
    "start": "pledge start"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "pledgestack": "latest",
    "pledgepack": "latest",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@types/node": "^22.0.0",
    "typescript": "^5.7.0"
  }
}
`,
  'app/layout.tsx': `import type { ReactNode } from 'react';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
      </body>
    </html>
  );
}
`,
  'app/page.tsx': `export default function HomePage() {
  return (
    <main>
      <h1>Welcome to PledgeStack</h1>
      <p>Get started by editing <code>app/page.tsx</code></p>
    </main>
  );
}
`,
  'app/head.tsx': `export default function Head() {
  return (
    <>
      <meta charSet="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>My PledgeStack App</title>
    </>
  );
}
`,
  'middleware.ts': `import { generateSecurityHeaders, generateCspHeader, DEFAULT_CSP } from 'pledgestack/auth';
import type { MiddlewareResult } from 'pledgestack';

const securityHeaders = generateSecurityHeaders({
  hsts: process.env.NODE_ENV === 'production',
});

const cspHeader = generateCspHeader(DEFAULT_CSP);

export function middleware(req: Request): MiddlewareResult {
  const headers: Record<string, string> = {
    ...securityHeaders,
    'Content-Security-Policy': cspHeader,
  };

  // HTTPS redirect in production
  if (process.env.NODE_ENV === 'production') {
    const proto = req.headers.get('x-forwarded-proto');
    if (proto === 'http') {
      const url = new URL(req.url);
      url.protocol = 'https:';
      return { redirect: url.toString(), permanent: true } as MiddlewareResult;
    }
  }

  return { next: true, headers };
}

export const config = {
  matcher: ['/((?!_next/|favicon.ico|robots.txt).*)'],
};
`,
  '.gitignore': `node_modules/
.pledge/
dist/
.env*.local
*.tsbuildinfo
`,
  'README.md': (name: string) => `# ${name}

Built with [PledgeStack](https://github.com/pledgeandgrow/pledgestack) — a full-stack React framework.

## Getting Started

\`\`\`bash
pnpm install
pnpm dev
\`\`\`

Open [http://localhost:3000](http://localhost:3000) in your browser.
`,
};

const BLANK_TEMPLATE = {
  ...DEFAULT_TEMPLATE,
  'app/page.tsx': `export default function HomePage() {
  return (
    <main>
      <h1>Blank PledgeStack App</h1>
    </main>
  );
}
`,
};

const BLOG_TEMPLATE = {
  ...DEFAULT_TEMPLATE,
  'app/page.tsx': `export default function HomePage() {
  return (
    <main>
      <h1>My Blog</h1>
      <ul>
        <li><a href="/posts/hello-world">Hello World</a></li>
      </ul>
    </main>
  );
}
`,
  'app/posts/[slug]/page.tsx': `interface PageProps {
  params: { slug: string };
}

export default function PostPage({ params }: PageProps) {
  return (
    <article>
      <h1>{params.slug}</h1>
      <p>This is a blog post.</p>
    </article>
  );
}

export function generateStaticParams() {
  return [{ slug: 'hello-world' }];
}
`,
};

/**
 * Creates a new PledgeStack project from a template.
 */
export async function createCommand(
  projectName: string,
  options: CreateOptions = {},
): Promise<void> {
  const template = options.template ?? 'default';
  const targetDir = join(process.cwd(), projectName);

  if (existsSync(targetDir)) {
    console.error(`\n  Error: Directory "${projectName}" already exists.\n`);
    process.exit(1);
  }

  console.log(`\n  PledgeStack — Creating project "${projectName}"...\n`);

  await mkdir(targetDir, { recursive: true });
  await mkdir(join(targetDir, 'app'), { recursive: true });
  await mkdir(join(targetDir, 'public'), { recursive: true });

  const templateFiles = getTemplate(template);

  for (const [filePath, content] of Object.entries(templateFiles)) {
    const fullPath = join(targetDir, filePath);
    const dir = join(fullPath, '..');
    await mkdir(dir, { recursive: true });

    const resolved = typeof content === 'function' ? content(projectName) : content;
    await writeFile(fullPath, resolved, 'utf-8');
    console.log(`  ✓ ${filePath}`);
  }

  const pm = options.packageManager ?? 'pnpm';

  console.log(`\n  Project created in ./${projectName}`);
  console.log(`\n  Next steps:`);
  console.log(`    cd ${projectName}`);
  console.log(`    ${pm} install`);
  console.log(`    ${pm} dev\n`);
}

function getTemplate(template: string): Record<string, string | ((name: string) => string)> {
  switch (template) {
    case 'blank':
      return BLANK_TEMPLATE;
    case 'blog':
      return BLOG_TEMPLATE;
    default:
      return DEFAULT_TEMPLATE;
  }
}
