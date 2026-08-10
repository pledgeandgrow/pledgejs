import { readFile, writeFile } from 'node:fs/promises';

export interface CodemodOptions {
  /** Transform name */
  name: string;
  /** File or directory to transform */
  path: string;
  /** Dry run (default: false) */
  dryRun?: boolean;
}

export interface CodemodTransform {
  name: string;
  description: string;
  transform: (source: string, filePath: string) => { code: string; changes: number };
}

export const REGISTERED_CODEMODS: CodemodTransform[] = [
  {
    name: 'pledgejs-to-pledgestack',
    description: 'Rename PledgeJS references to PledgeStack',
    transform: (source) => {
      let changes = 0;
      let code = source;
      code = code.replace(/PledgeJS/g, () => { changes++; return 'PledgeStack'; });
      code = code.replace(/pledgejs/g, () => { changes++; return 'pledgestack'; });
      return { code, changes };
    },
  },
  {
    name: 'next-to-pledge',
    description: 'Migrate Next.js imports to PledgeStack',
    transform: (source) => {
      let changes = 0;
      let code = source;
      code = code.replace(/from ['"]next\/navigation['"]/g, (m) => { changes++; return m.replace('next/navigation', 'pledge'); });
      code = code.replace(/from ['"]next\/image['"]/g, (m) => { changes++; return m.replace('next/image', 'pledge/image'); });
      code = code.replace(/from ['"]next\/font['"]/g, (m) => { changes++; return m.replace('next/font', 'pledge/font'); });
      code = code.replace(/from ['"]next\/link['"]/g, (m) => { changes++; return m.replace('next/link', 'pledge/link'); });
      code = code.replace(/from ['"]next\/server['"]/g, (m) => { changes++; return m.replace('next/server', 'pledge/server'); });
      code = code.replace(/from ['"]next\/headers['"]/g, (m) => { changes++; return m.replace('next/headers', 'pledge/headers'); });
      code = code.replace(/from ['"]next\/cookies['"]/g, (m) => { changes++; return m.replace('next/cookies', 'pledge/cookies'); });
      return { code, changes };
    },
  },
  {
    name: 'use-client-to-pledge-client',
    description: 'Convert "use client" to "use pledge:client"',
    transform: (source) => {
      let changes = 0;
      let code = source;
      code = code.replace(/^['"]use client['"]/gm, () => { changes++; return '"use pledge:client"'; });
      return { code, changes };
    },
  },
  {
    name: 'api-routes-to-route-handlers',
    description: 'Convert Next.js API routes to PledgeStack route handlers',
    transform: (source) => {
      let changes = 0;
      let code = source;
      code = code.replace(/export default function handler\(/g, () => { changes++; return 'export function GET('; });
      code = code.replace(/req\.query/g, () => { changes++; return 'req.searchParams'; });
      code = code.replace(/req\.body/g, () => { changes++; return 'await req.json()'; });
      return { code, changes };
    },
  },
  {
    name: 'get-server-side-props-to-server-component',
    description: 'Convert getServerSideProps to server component data fetching',
    transform: (source) => {
      let changes = 0;
      let code = source;

      // Remove getServerSideProps export and extract its body
      code = code.replace(
        /export\s+async\s+function\s+getServerSideProps\s*\(\s*(?:context|ctx)\s*:\s*\{[^}]*\}\s*\)\s*\{([\s\S]*?)\n\}/g,
        (_match, body) => {
          changes++;
          // Convert context.params to params prop
          const converted = body
            .replace(/context\.params/g, 'params')
            .replace(/ctx\.params/g, 'params')
            .replace(/context\.req\.headers/g, 'headers')
            .replace(/ctx\.req\.headers/g, 'headers')
            .replace(/context\.query/g, 'searchParams')
            .replace(/ctx\.query/g, 'searchParams');
          return `// TODO: Move data fetching into the component body (server component)
// Converted from getServerSideProps:
async function fetchData(params: Record<string, string>, searchParams: Record<string, string>) {
${converted}
}`;
        },
      );

      // Add "use pledge:server" directive if not present
      if (changes > 0 && !code.includes('"use pledge:server"')) {
        code = '"use pledge:server";\n' + code;
        changes++;
      }

      return { code, changes };
    },
  },
  {
    name: 'get-static-props-to-generate-static-params',
    description: 'Convert getStaticProps to generateStaticParams + server component',
    transform: (source) => {
      let changes = 0;
      let code = source;

      // Convert getStaticPaths to generateStaticParams
      code = code.replace(
        /export\s+async\s+function\s+getStaticPaths\s*\(\s*\)\s*\{([\s\S]*?)\n\}/g,
        (_match, body) => {
          changes++;
          // Extract paths return — convert to generateStaticParams format
          const converted = body
            .replace(/paths:\s*\[/g, 'return [')
            .replace(/fallback:\s*(true|false|'blocking')/g, '// fallback is automatic in PledgeStack');
          return `export async function generateStaticParams() {
${converted}
}`;
        },
      );

      // Remove getStaticProps and add TODO
      code = code.replace(
        /export\s+async\s+function\s+getStaticProps\s*\(\s*(?:context|ctx)\s*:\s*\{[^}]*\}\s*\)\s*\{[\s\S]*?\n\}/g,
        () => {
          changes++;
          return '// TODO: Move static data fetching into the component body (server component)\n// Use generateStaticParams() for dynamic route pre-generation';
        },
      );

      return { code, changes };
    },
  },
  {
    name: 'next-image-to-img',
    description: 'Convert next/image Image component to native img',
    transform: (source) => {
      let changes = 0;
      let code = source;

      // Replace import
      code = code.replace(/import\s+Image\s+from\s+['"]next\/image['"];?/g, () => {
        changes++;
        return '';
      });
      code = code.replace(/import\s+\{\s*Image\s*\}\s+from\s+['"]next\/image['"];?/g, () => {
        changes++;
        return '';
      });

      // Replace <Image> with <img>
      code = code.replace(/<Image\s+/g, () => { changes++; return '<img '; });
      code = code.replace(/<\/Image>/g, () => { changes++; return '</img>'; });

      // Remove next/image specific props
      code = code.replace(/\s+priority(?=\s|>)/g, () => { changes++; return ''; });
      code = code.replace(/\s+placeholder="[^"]*"(?=\s|>)/g, () => { changes++; return ''; });
      code = code.replace(/\s+blurDataURL="[^"]*"(?=\s|>)/g, () => { changes++; return ''; });
      code = code.replace(/\s+fill(?=\s|>)/g, () => { changes++; return ''; });
      code = code.replace(/\s+sizes="[^"]*"(?=\s|>)/g, () => { changes++; return ''; });

      // Convert width/height to style
      code = code.replace(
        /<img\s+([^>]*?)width=\{(\d+)\}\s+height=\{(\d+)\}([^>]*?)>/g,
        (_m, before, w, h, after) => {
          changes++;
          return `<img ${before}style={{ width: ${w}, height: ${h} }}${after}>`;
        },
      );

      return { code, changes };
    },
  },
  {
    name: 'next-router-to-pledge-router',
    description: 'Convert next/router and next/navigation to pledgestack/router',
    transform: (source) => {
      let changes = 0;
      let code = source;

      // Import conversions
      code = code.replace(/from\s+['"]next\/router['"]/g, () => { changes++; return "from 'pledgestack/router'"; });
      code = code.replace(/from\s+['"]next\/navigation['"]/g, () => { changes++; return "from 'pledgestack/router'"; });

      // useRouter usage
      code = code.replace(/const\s+router\s*=\s*useRouter\(\)/g, () => { changes++; return 'const router = useRouter()'; });

      // router.push → router.navigate
      code = code.replace(/router\.push\(/g, () => { changes++; return 'router.navigate('; });

      // router.replace → router.replace (same in PledgeStack)
      // router.back → router.back (same)
      // router.reload → router.reload (same)

      // usePathname, useSearchParams, useParams
      code = code.replace(/usePathname\(\)/g, () => { changes++; return 'usePathname()'; });
      code = code.replace(/useSearchParams\(\)/g, () => { changes++; return 'useSearchParams()'; });
      code = code.replace(/useParams\(\)/g, () => { changes++; return 'useParams()'; });

      // Link import
      code = code.replace(/import\s+Link\s+from\s+['"]next\/link['"]/g, () => {
        changes++;
        return "import { Link } from 'pledgestack/router'";
      });

      // <Link href> stays the same but needs the import change
      // next/font → pledgestack/font
      code = code.replace(/from\s+['"]next\/font\/google['"]/g, () => { changes++; return "from 'pledgestack/font'"; });
      code = code.replace(/from\s+['"]next\/font\/local['"]/g, () => { changes++; return "from 'pledgestack/font'"; });

      // next/headers → pledgestack/headers
      code = code.replace(/from\s+['"]next\/headers['"]/g, () => { changes++; return "from 'pledgestack/headers'"; });

      // next/cookies → pledgestack/cookies
      code = code.replace(/from\s+['"]next\/cookies['"]/g, () => { changes++; return "from 'pledgestack/cookies'"; });

      // next/server → pledgestack/server
      code = code.replace(/from\s+['"]next\/server['"]/g, () => { changes++; return "from 'pledgestack/server'"; });

      return { code, changes };
    },
  },
  {
    name: 'metadata-api-to-pledge',
    description: 'Convert Next.js metadata export to PledgeStack generateMetadata',
    transform: (source) => {
      let changes = 0;
      let code = source;

      // Convert static metadata export to generateMetadata function
      code = code.replace(
        /export\s+const\s+metadata\s*[:=]\s*\{([\s\S]*?)\};/g,
        (_match, metadataBody) => {
          changes++;
          return `export function generateMetadata() {
  return {${metadataBody}};
}`;
        },
      );

      // Convert viewport export
      code = code.replace(
        /export\s+const\s+viewport\s*[:=]\s*\{([\s\S]*?)\};/g,
        (_match, viewportBody) => {
          changes++;
          return `export function generateViewport() {
  return {${viewportBody}};
}`;
        },
      );

      return { code, changes };
    },
  },
  {
    name: 'next-dynamic-to-lazy',
    description: 'Convert next/dynamic to React.lazy with Suspense',
    transform: (source) => {
      let changes = 0;
      let code = source;

      // Replace import
      code = code.replace(/import\s+dynamic\s+from\s+['"]next\/dynamic['"]/g, () => {
        changes++;
        return "import { lazy, Suspense } from 'react'";
      });

      // Convert dynamic(() => import('...')) to lazy(() => import('...'))
      code = code.replace(
        /dynamic\(\s*\(\)\s*=>\s*import\(['"]([^'"]+)['"]\)/g,
        (_m, importPath) => {
          changes++;
          return `lazy(() => import('${importPath}'))`;
        },
      );

      // Convert dynamic with ssr: false
      code = code.replace(
        /dynamic\(\s*\(\)\s*=>\s*import\(['"]([^'"]+)['"]\),\s*\{\s*ssr:\s*false\s*\}\)/g,
        (_m, importPath) => {
          changes++;
          return `lazy(() => import('${importPath}'))`;
        },
      );

      return { code, changes };
    },
  },
  {
    name: 'remove-next-specific',
    description: 'Remove Next.js-specific files and patterns (_document, _app, getInitialProps)',
    transform: (source) => {
      let changes = 0;
      let code = source;

      // Remove getInitialProps
      code = code.replace(
        /(?:Page|Component)\.getInitialProps\s*=\s*async\s+function\s*\([^)]*\)\s*\{[\s\S]*?\n\}/g,
        () => {
          changes++;
          return '// TODO: Convert getInitialProps to server component data fetching';
        },
      );

      // Remove next/head usage (replaced by head.tsx in PledgeStack)
      code = code.replace(/import\s+Head\s+from\s+['"]next\/head['"]/g, () => {
        changes++;
        return '// Head is handled by app/head.tsx in PledgeStack';
      });
      code = code.replace(/<Head>/g, () => { changes++; return '<>'; });
      code = code.replace(/<\/Head>/g, () => { changes++; return '</>'; });

      // Remove next/script
      code = code.replace(/import\s+Script\s+from\s+['"]next\/script['"]/g, () => {
        changes++;
        return '// Use native <script> tags in PledgeStack';
      });
      code = code.replace(/<Script\s+/g, () => { changes++; return '<script '; });
      code = code.replace(/<\/Script>/g, () => { changes++; return '</script>'; });

      return { code, changes };
    },
  },
];

export function listCodemods(): Array<{ name: string; description: string }> {
  return REGISTERED_CODEMODS.map((c) => ({ name: c.name, description: c.description }));
}

export async function runCodemod(options: CodemodOptions): Promise<{ filesChanged: number; totalChanges: number }> {
  const codemod = REGISTERED_CODEMODS.find((c) => c.name === options.name);
  if (!codemod) {
    throw new Error(`Unknown codemod: ${options.name}. Available: ${REGISTERED_CODEMODS.map((c) => c.name).join(', ')}`);
  }

  const { dryRun = false } = options;
  let filesChanged = 0;
  let totalChanges = 0;

  try {
    const source = await readFile(options.path, 'utf-8');
    const result = codemod.transform(source, options.path);

    if (result.changes > 0) {
      filesChanged++;
      totalChanges += result.changes;

      if (!dryRun) {
        await writeFile(options.path, result.code, 'utf-8');
        console.log(`  ${options.path}: ${result.changes} change(s)`);
      } else {
        console.log(`  [dry-run] ${options.path}: ${result.changes} change(s)`);
      }
    }
  } catch (err) {
    console.error(`  Error processing ${options.path}: ${err}`);
  }

  console.log(`\nCodemod "${options.name}" complete: ${filesChanged} file(s), ${totalChanges} change(s)`);
  return { filesChanged, totalChanges };
}
