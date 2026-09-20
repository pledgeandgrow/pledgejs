/**
 * Render-time security helpers — CSP nonces and SRI integrity stamping.
 *
 * The implementation lives in pledgestack-shared (render-security.ts) so
 * every renderer adapter can stamp its own output; re-exported here for
 * the render pipeline.
 */

export {
  generateCspNonce,
  scriptSecurityAttrs,
  applyScriptSecurity,
  escapeJsonForScript,
  findExternalAssetsWithoutIntegrity,
} from 'pledgestack-shared';
export type { RenderSecurity } from 'pledgestack-shared';
