import type { ScannedFile } from './scanner';
import type { ResolvedRoute, PledgeConfig, RenderMode, Runtime } from 'pledgestack-shared';
import { FILE_CONVENTIONS, PARALLEL_ROUTE_PATTERN, INTERCEPT_ROUTE_SEGMENT_PATTERN, INTERCEPT_ROUTE_PATTERN } from 'pledgestack-shared';
import { pathToPattern } from '../router/match';

/**
 * Resolves scanned files into ResolvedRoute objects.
 * Groups convention files (loading, error, not-found, head) by directory
 * and attaches them to their associated page or route handler.
 *
 * Supports:
 * - Route groups (group) — logical grouping without URL impact
 * - Parallel routes @slot — independent route trees rendered in layout
 * - Intercepting routes (..)folder — route interception for modals
 */
export function resolveRoutes(files: ScannedFile[], config: PledgeConfig): ResolvedRoute[] {
  const routes: ResolvedRoute[] = [];

  // Group files by their directory path
  const byDirectory = new Map<string, ScannedFile[]>();
  for (const file of files) {
    const dir = file.segments.slice(0, -1).join('/');
    if (!byDirectory.has(dir)) byDirectory.set(dir, []);
    byDirectory.get(dir)!.push(file);
  }

  // Collect parallel slot pages: slotName -> filePath
  const slotPages = new Map<string, ScannedFile>();

  for (const [dir, dirFiles] of byDirectory) {
    // Find the primary route file (page or route handler) in this directory
    const pageFile = dirFiles.find((f) => f.convention === FILE_CONVENTIONS.page);
    const routeFile = dirFiles.find((f) => f.convention === FILE_CONVENTIONS.route);

    // Find convention files in this directory
    const loadingFile = dirFiles.find((f) => f.convention === FILE_CONVENTIONS.loading);
    const errorFile = dirFiles.find((f) => f.convention === FILE_CONVENTIONS.error);
    const notFoundFile = dirFiles.find((f) => f.convention === FILE_CONVENTIONS['not-found']);
    const headFile = dirFiles.find((f) => f.convention === FILE_CONVENTIONS.head);
    const templateFile = dirFiles.find((f) => f.convention === FILE_CONVENTIONS.template);
    const ogImageFile = dirFiles.find((f) => f.convention === FILE_CONVENTIONS['opengraph-image']);
    const twImageFile = dirFiles.find((f) => f.convention === FILE_CONVENTIONS['twitter-image']);

    // Check if this directory is inside a parallel route slot (@slot)
    const dirSegments = dir.split('/').filter(Boolean);
    const slotIndex = dirSegments.findIndex((s) => PARALLEL_ROUTE_PATTERN.test(s));
    const isSlotPage = slotIndex !== -1 && !!pageFile;

    // Check if this is an intercepting route
    const interceptSegment = dirSegments.find((s) => INTERCEPT_ROUTE_SEGMENT_PATTERN.test(s) || INTERCEPT_ROUTE_PATTERN.test(s));
    const interceptMatch = interceptSegment?.match(INTERCEPT_ROUTE_SEGMENT_PATTERN);
    const interceptLevel = interceptMatch ? (interceptMatch[0].match(/\./g)?.length ?? 1) - 1 : undefined;

    // If this directory has a page or route file, create a route with attached conventions
    if (pageFile || routeFile) {
      const primary = pageFile ?? routeFile!;
      const isRoute = !!routeFile;
      const routeDirSegments = primary.segments.slice(0, -1);
      const pattern = pathToPattern(routeDirSegments.join('/'));
      const mode: RenderMode = isRoute ? 'api' : 'ssr';
      const runtime: Runtime = config.defaultRuntime;

      // If this is a slot page, register it in slotPages for the parent to pick up
      if (isSlotPage) {
        const slotName = dirSegments[slotIndex].match(PARALLEL_ROUTE_PATTERN)?.[1] ?? '';
        slotPages.set(`${dirSegments.slice(0, slotIndex).join('/')}:${slotName}`, pageFile!);
      }

      routes.push({
        filePath: primary.absolutePath,
        pattern,
        mode,
        runtime,
        isLayout: false,
        isErrorBoundary: false,
        isLoading: false,
        isNotFound: false,
        loadingFilePath: loadingFile?.absolutePath,
        errorFilePath: errorFile?.absolutePath,
        notFoundFilePath: notFoundFile?.absolutePath,
        headFilePath: headFile?.absolutePath,
        templateFilePath: templateFile?.absolutePath,
        opengraphImageFilePath: ogImageFile?.absolutePath,
        twitterImageFilePath: twImageFile?.absolutePath,
        interceptLevel,
      });
    }

    // Handle standalone layout files
    const layoutFile = dirFiles.find((f) => f.convention === FILE_CONVENTIONS.layout);
    if (layoutFile && !pageFile && !routeFile) {
      const layoutDirSegments = layoutFile.segments.slice(0, -1);
      const pattern = pathToPattern(layoutDirSegments.join('/'));

      // Collect slots for this layout
      const slots: Record<string, string> = {};
      const layoutDir = layoutDirSegments.join('/');
      for (const [slotKey, slotFile] of slotPages.entries()) {
        const [parentDir, slotName] = slotKey.split(':');
        if (parentDir === layoutDir) {
          slots[slotName] = slotFile.absolutePath;
        }
      }

      routes.push({
        filePath: layoutFile.absolutePath,
        pattern,
        mode: 'ssr',
        runtime: config.defaultRuntime,
        isLayout: true,
        isErrorBoundary: false,
        isLoading: false,
        isNotFound: false,
        loadingFilePath: loadingFile?.absolutePath,
        errorFilePath: errorFile?.absolutePath,
        notFoundFilePath: notFoundFile?.absolutePath,
        headFilePath: headFile?.absolutePath,
        slots: Object.keys(slots).length > 0 ? slots : undefined,
        opengraphImageFilePath: ogImageFile?.absolutePath,
        twitterImageFilePath: twImageFile?.absolutePath,
      });
    }

    // Handle standalone not-found at root level
    if (notFoundFile && !pageFile && !routeFile && !layoutFile) {
      const nfDirSegments = notFoundFile.segments.slice(0, -1);
      const pattern = nfDirSegments.length === 0 ? '/404' : pathToPattern(nfDirSegments.join('/'));
      routes.push({
        filePath: notFoundFile.absolutePath,
        pattern,
        mode: 'ssr',
        runtime: config.defaultRuntime,
        isLayout: false,
        isErrorBoundary: false,
        isLoading: false,
        isNotFound: true,
      });
    }
  }

  return routes;
}
