import type { PledgeRequest, PledgeResponse } from 'pledgestack-shared';

/**
 * Format a single CSV cell, defending against CSV/formula injection.
 *
 * The exported data is arbitrary user-collected content. A cell that begins
 * with `=`, `+`, `-`, `@`, or a tab/CR would be interpreted as a formula when
 * the export is opened in Excel/Sheets by an admin. We neutralize it by
 * prefixing a single quote, then apply standard quote-escaping/quoting.
 */
function csvCell(value: unknown): string {
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) {
    s = `'${s}`;
  }
  return `"${s.replace(/"/g, '""')}"`;
}

export interface UserDataRecord {
  /** Data source identifier (e.g. 'database', 'cache', 'logs') */
  source: string;
  /** Record ID or identifier */
  id: string;
  /** The data payload */
  data: Record<string, unknown>;
  /** Timestamp of collection */
  collectedAt: number;
}

export interface DataExportResult {
  /** User identifier */
  userId: string;
  /** Export timestamp */
  exportedAt: number;
  /** Format of the export */
  format: 'json' | 'csv';
  /** All user data records */
  records: UserDataRecord[];
}

export interface RightToBeForgottenResult {
  userId: string;
  deletedAt: number;
  /** Sources that were purged */
  purgedSources: string[];
  /** Sources that could not be purged (legal hold, etc.) */
  retainedSources: string[];
  /** Reason for any retention */
  retentionReason?: string;
}

/**
 * Data collector interface — implement per data source.
 * Each collector knows how to retrieve and delete user data from its source.
 */
export interface UserDataCollector {
  /** Source name (e.g. 'database', 'cache', 'audit-log') */
  name: string;
  /** Retrieve all data for a user */
  export(userId: string): Promise<UserDataRecord[]>;
  /** Delete all data for a user */
  delete(userId: string): Promise<number>;
  /** Whether this source can be deleted (some are legally required to retain) */
  canDelete: boolean;
  /** Reason for retention if canDelete is false */
  retentionReason?: string;
}

/**
 * GDPR compliance helpers — right to be forgotten, data export.
 *
 * Register data collectors for each source, then call exportData()
 * or deleteData() to handle GDPR requests.
 */
export class GDPRManager {
  private collectors: Map<string, UserDataCollector> = new Map();

  registerCollector(collector: UserDataCollector): void {
    if (this.collectors.has(collector.name)) {
      throw new Error(`Data collector "${collector.name}" already registered`);
    }
    this.collectors.set(collector.name, collector);
  }

  /**
   * Export all user data in machine-readable format (GDPR Article 15).
   */
  async exportData(userId: string, format: 'json' | 'csv' = 'json'): Promise<DataExportResult> {
    const records: UserDataRecord[] = [];

    for (const collector of this.collectors.values()) {
      try {
        const data = await collector.export(userId);
        records.push(...data);
      } catch (err) {
        console.error(`[pledgestack] GDPR export failed for source "${collector.name}":`, err);
      }
    }

    return {
      userId,
      exportedAt: Date.now(),
      format,
      records,
    };
  }

  /**
   * Execute right to be forgotten (GDPR Article 17).
   * Deletes data from all collectors that allow deletion.
   * Retains data from collectors with legal hold.
   */
  async deleteData(userId: string): Promise<RightToBeForgottenResult> {
    const purgedSources: string[] = [];
    const retainedSources: string[] = [];
    let retentionReason: string | undefined;

    for (const collector of this.collectors.values()) {
      if (!collector.canDelete) {
        retainedSources.push(collector.name);
        retentionReason = collector.retentionReason;
        continue;
      }

      try {
        await collector.delete(userId);
        purgedSources.push(collector.name);
      } catch (err) {
        console.error(`[pledgestack] GDPR deletion failed for source "${collector.name}":`, err);
        retainedSources.push(collector.name);
      }
    }

    return {
      userId,
      deletedAt: Date.now(),
      purgedSources,
      retainedSources,
      retentionReason,
    };
  }

  /**
   * Create a data export response (JSON format) for an API route.
   * Usage: `return gdpr.exportResponse(userId)` in a `route.ts` file.
   */
  async exportResponse(userId: string, format: 'json' | 'csv' = 'json'): Promise<PledgeResponse> {
    const result = await this.exportData(userId, format);

    if (format === 'csv') {
      const csv = this.toCSV(result);
      return {
        status: 200,
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': `attachment; filename="user-data-${userId}.csv"`,
        },
        body: csv,
      };
    }

    return {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="user-data-${userId}.json"`,
      },
      body: JSON.stringify(result, null, 2),
    };
  }

  /**
   * Create a deletion confirmation response for an API route.
   */
  async deletionResponse(userId: string): Promise<PledgeResponse> {
    const result = await this.deleteData(userId);
    return {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result, null, 2),
    };
  }

  /**
   * Verify the request is from the data owner (basic check via session user ID).
   */
  verifyOwner(req: PledgeRequest, userId: string): boolean {
    const sessionUserId = (req as PledgeRequest & { session?: { userId?: string } }).session?.userId;
    return sessionUserId === userId;
  }

  private toCSV(result: DataExportResult): string {
    const headers = ['source', 'id', 'collectedAt', 'data'];
    const rows = result.records.map((r) => [
      r.source,
      r.id,
      new Date(r.collectedAt).toISOString(),
      JSON.stringify(r.data),
    ]);
    return [headers, ...rows].map((row) => row.map((c) => csvCell(c)).join(',')).join('\n');
  }
}
