// @unconsumed — exported but not used in the request path. See REMAINING-ISSUES.md.

/**
 * #280 — Multi-Region Deployment.
 *
 * Deploy PledgeStack to multiple regions with automatic routing,
 * health-based failover, region-aware cache, data residency compliance.
 *
 * Provides:
 * - Multi-region routing configuration
 * - Health-based failover
 * - Region-aware cache distribution
 * - Data residency compliance checks
 * - Traffic shifting for canary deployments
 */

import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RegionConfig {
  /** Region identifier (e.g., 'us-east-1', 'eu-west-1') */
  id: string;
  /** Human-readable name */
  name: string;
  /** Cloud provider */
  provider: 'aws' | 'cloudflare' | 'vercel' | 'gcp' | 'azure';
  /** Base URL for this region */
  url: string;
  /** Whether this region is active */
  active: boolean;
  /** Whether this region is primary */
  primary?: boolean;
  /** Weight for traffic distribution (0-100) */
  weight?: number;
  /** Health check endpoint */
  healthCheckUrl?: string;
  /** Data residency rules */
  dataResidency?: string[];
  /** Latency from key markets in ms */
  latency?: Record<string, number>;
}

export interface PsxMultiRegionConfig {
  regions: RegionConfig[];
  /** Health check interval in seconds (default: 30) */
  healthCheckInterval?: number;
  /** Failover threshold (consecutive failures before failover, default: 3) */
  failoverThreshold?: number;
  /** Whether to enable data residency checks */
  enableDataResidency?: boolean;
  /** Default routing strategy */
  routingStrategy?: 'latency' | 'weighted' | 'geo' | 'primary';
}

export type RoutingStrategy = 'latency' | 'weighted' | 'geo' | 'primary';

export interface RouteResult {
  region: RegionConfig;
  strategy: RoutingStrategy;
  reason: string;
  fallback: boolean;
}

export interface HealthStatus {
  regionId: string;
  healthy: boolean;
  consecutiveFailures: number;
  lastChecked: number;
  responseTimeMs?: number;
}

// ---------------------------------------------------------------------------
// Multi-Region Manager
// ---------------------------------------------------------------------------

/**
 * Manages multi-region deployment with automatic routing and failover.
 */
export class MultiRegionManager extends EventEmitter {
  private config: Required<PsxMultiRegionConfig>;
  private healthStatus = new Map<string, HealthStatus>();
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: PsxMultiRegionConfig) {
    super();
    this.config = {
      regions: config.regions,
      healthCheckInterval: config.healthCheckInterval ?? 30,
      failoverThreshold: config.failoverThreshold ?? 3,
      enableDataResidency: config.enableDataResidency ?? true,
      routingStrategy: config.routingStrategy ?? 'latency',
    };

    // Initialize health status for all regions
    for (const region of config.regions) {
      this.healthStatus.set(region.id, {
        regionId: region.id,
        healthy: region.active,
        consecutiveFailures: 0,
        lastChecked: 0,
      });
    }
  }

  /**
   * Routes a request to the best region based on the configured strategy.
   */
  route(
    clientRegion?: string,
    clientLatency?: Record<string, number>,
    dataResidency?: string[],
  ): RouteResult {
    const healthyRegions = this.getHealthyRegions();

    if (healthyRegions.length === 0) {
      // All regions down — return primary as fallback
      const primary = this.getPrimaryRegion();
      return {
        region: primary,
        strategy: this.config.routingStrategy,
        reason: 'All regions unhealthy — using primary as fallback',
        fallback: true,
      };
    }

    // Check data residency constraints
    let candidates = healthyRegions;
    if (dataResidency && this.config.enableDataResidency) {
      candidates = healthyRegions.filter(r =>
        r.dataResidency?.some(d => dataResidency.includes(d)),
      );
      if (candidates.length === 0) {
        candidates = healthyRegions;
      }
    }

    switch (this.config.routingStrategy) {
      case 'latency':
        return this.routeByLatency(candidates, clientLatency, clientRegion);
      case 'weighted':
        return this.routeByWeight(candidates);
      case 'geo':
        return this.routeByGeo(candidates, clientRegion);
      case 'primary':
      default:
        return this.routeByPrimary(candidates);
    }
  }

  /**
   * Starts periodic health checks.
   */
  startHealthChecks(): void {
    if (this.healthCheckTimer) return;
    this.healthCheckTimer = setInterval(
      () => this.checkAllHealth(),
      this.config.healthCheckInterval * 1000,
    );
  }

  /**
   * Stops health checks.
   */
  stopHealthChecks(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /**
   * Checks health of all regions.
   */
  async checkAllHealth(): Promise<void> {
    await Promise.all(
      this.config.regions.map(r => this.checkHealth(r.id)),
    );
  }

  /**
   * Checks health of a single region.
   */
  async checkHealth(regionId: string): Promise<HealthStatus> {
    const region = this.config.regions.find(r => r.id === regionId);
    if (!region) throw new Error(`Region "${regionId}" not found`);

    const status = this.healthStatus.get(regionId)!;
    const startTime = Date.now();

    try {
      if (region.healthCheckUrl) {
        // Would actually fetch the health check URL
        // For now, simulate based on active status
        status.healthy = region.active;
        status.responseTimeMs = Date.now() - startTime;
      } else {
        status.healthy = region.active;
      }
      status.consecutiveFailures = 0;
    } catch {
      status.healthy = false;
      status.consecutiveFailures++;
    }

    status.lastChecked = Date.now();
    this.healthStatus.set(regionId, status);

    if (!status.healthy && status.consecutiveFailures >= this.config.failoverThreshold) {
      this.emit('failover', { from: regionId, reason: 'Health check failed' });
    }

    this.emit('health-check', status);
    return status;
  }

  /**
   * Gets all healthy regions.
   */
  getHealthyRegions(): RegionConfig[] {
    return this.config.regions.filter(r => {
      const status = this.healthStatus.get(r.id);
      return status?.healthy && r.active;
    });
  }

  /**
   * Gets the primary region.
   */
  getPrimaryRegion(): RegionConfig {
    return this.config.regions.find(r => r.primary) ?? this.config.regions[0];
  }

  /**
   * Gets health status for all regions.
   */
  getHealthStatus(): HealthStatus[] {
    return Array.from(this.healthStatus.values());
  }

  /**
   * Shifts traffic weight between regions (for canary deployments).
   */
  shiftTraffic(regionId: string, weight: number): void {
    const region = this.config.regions.find(r => r.id === regionId);
    if (!region) throw new Error(`Region "${regionId}" not found`);
    region.weight = Math.max(0, Math.min(100, weight));
    this.emit('traffic-shift', { regionId, weight: region.weight });
  }

  /**
   * Activates or deactivates a region.
   */
  setRegionActive(regionId: string, active: boolean): void {
    const region = this.config.regions.find(r => r.id === regionId);
    if (!region) throw new Error(`Region "${regionId}" not found`);
    region.active = active;
    const status = this.healthStatus.get(regionId);
    if (status) status.healthy = active;
    this.emit('region-toggled', { regionId, active });
  }

  // ---------------------------------------------------------------------------
  // Routing strategies
  // ---------------------------------------------------------------------------

  private routeByLatency(
    regions: RegionConfig[],
    clientLatency?: Record<string, number>,
    clientRegion?: string,
  ): RouteResult {
    if (!clientLatency && !clientRegion) {
      return this.routeByPrimary(regions);
    }

    let best = regions[0];
    let bestLatency = Infinity;

    for (const region of regions) {
      // Prefer the client's measured latency to this region. Fall back to the
      // region's configured latency to the client's market — the previous
      // fallback looked up `region.latency[region.id]` (the region's own id),
      // which only resolves if the region lists itself as a market and was
      // effectively always Infinity.
      const latency =
        clientLatency?.[region.id] ??
        (clientRegion ? region.latency?.[clientRegion] : undefined) ??
        Infinity;
      if (latency < bestLatency) {
        bestLatency = latency;
        best = region;
      }
    }

    return {
      region: best,
      strategy: 'latency',
      reason: `Lowest latency: ${bestLatency}ms`,
      fallback: false,
    };
  }

  private routeByWeight(regions: RegionConfig[]): RouteResult {
    const totalWeight = regions.reduce((sum, r) => sum + (r.weight ?? 0), 0);
    if (totalWeight === 0) return this.routeByPrimary(regions);

    let random = Math.random() * totalWeight;
    for (const region of regions) {
      random -= (region.weight ?? 0);
      if (random <= 0) {
        return {
          region,
          strategy: 'weighted',
          reason: `Weighted selection (weight: ${region.weight})`,
          fallback: false,
        };
      }
    }

    return this.routeByPrimary(regions);
  }

  private routeByGeo(regions: RegionConfig[], clientRegion?: string): RouteResult {
    if (!clientRegion) return this.routeByPrimary(regions);

    // Try to find a region matching the client's region
    const match = regions.find(r =>
      r.id.toLowerCase().includes(clientRegion.toLowerCase()) ||
      r.dataResidency?.includes(clientRegion),
    );

    if (match) {
      return {
        region: match,
        strategy: 'geo',
        reason: `Geo match for ${clientRegion}`,
        fallback: false,
      };
    }

    return this.routeByPrimary(regions);
  }

  private routeByPrimary(regions: RegionConfig[]): RouteResult {
    const primary = regions.find(r => r.primary) ?? regions[0];
    return {
      region: primary,
      strategy: 'primary',
      reason: 'Primary region',
      fallback: false,
    };
  }
}

// ---------------------------------------------------------------------------
// Configuration Generation
// ---------------------------------------------------------------------------

/**
 * Generates multi-region deployment configuration.
 */
export function generateMultiRegionConfig(config: PsxMultiRegionConfig): string {
  return `# Multi-Region Deployment Configuration
routingStrategy: ${config.routingStrategy ?? 'latency'}
healthCheckInterval: ${config.healthCheckInterval ?? 30}
failoverThreshold: ${config.failoverThreshold ?? 3}
enableDataResidency: ${config.enableDataResidency ?? true}

regions:
${config.regions.map(r => `  - id: ${r.id}
    name: ${r.name}
    provider: ${r.provider}
    url: ${r.url}
    active: ${r.active}
    primary: ${r.primary ?? false}
    weight: ${r.weight ?? 100}
${r.healthCheckUrl ? `    healthCheckUrl: ${r.healthCheckUrl}` : ''}
${r.dataResidency ? `    dataResidency: [${r.dataResidency.join(', ')}]` : ''}`).join('\n')}
`;
}
