/**
 * Server Components Flight Protocol — custom wire format for RSC payloads.
 *
 * Instead of serializing the RSC tree as plain JSON, this module implements
 * a lightweight flight protocol inspired by React's own flight format.
 *
 * The format uses line-delimited chunks:
 *   [type]:[id]:[data]\n
 *
 * Types:
 *   M - Module reference (client component)
 *   S - String reference
 *   J - JSON data (props, state)
 *   L - Lazy module (for code splitting)
 *   E - Error
 *
 * This enables:
 * - Streaming deserialization (process chunks as they arrive)
 * - Reference deduplication (same module/data sent once)
 * - Type-aware decoding on the client
 */

export type FlightType = 'M' | 'S' | 'J' | 'L' | 'E';

export interface FlightChunk {
  type: FlightType;
  id: number;
  data: unknown;
}

export interface FlightPayload {
  chunks: FlightChunk[];
  moduleMap: Record<string, string>;
}

/**
 * Encodes a flight payload into the wire format string.
 */
export function encodeFlight(payload: FlightPayload): string {
  const lines: string[] = [];

  for (const chunk of payload.chunks) {
    let data: string;
    if (chunk.type === 'M' || chunk.type === 'L') {
      const moduleId = chunk.data as string;
      // Carry the module→chunk-path mapping on the wire so decode can rebuild
      // moduleMap. Previously only the moduleId was written, so the module map
      // (and thus reference dedup) was lost on every round-trip.
      data = JSON.stringify({ moduleId, chunkPath: payload.moduleMap[moduleId] });
    } else {
      data = JSON.stringify(chunk.data);
    }
    lines.push(`${chunk.type}:${chunk.id}:${data}`);
  }

  return lines.join('\n');
}

/**
 * Decodes a flight format string back into a flight payload.
 * Processes chunks incrementally — can be called with partial data.
 */
export function decodeFlight(encoded: string): FlightPayload {
  const chunks: FlightChunk[] = [];
  const moduleMap: Record<string, string> = {};
  const lines = encoded.split('\n');

  for (const line of lines) {
    if (!line.trim()) continue;
    const colonIdx = line.indexOf(':');
    const secondColonIdx = line.indexOf(':', colonIdx + 1);
    if (colonIdx === -1 || secondColonIdx === -1) continue;

    const type = line.slice(0, colonIdx) as FlightType;
    const id = parseInt(line.slice(colonIdx + 1, secondColonIdx), 10);
    const dataStr = line.slice(secondColonIdx + 1);

    let data: unknown;
    try {
      if (type === 'M' || type === 'L') {
        const parsed = JSON.parse(dataStr) as { moduleId: string; chunkPath?: string };
        data = parsed.moduleId;
        // Reconstruct the module map from the M/L chunks.
        if (parsed.chunkPath !== undefined) moduleMap[parsed.moduleId] = parsed.chunkPath;
      } else {
        data = JSON.parse(dataStr);
      }
    } catch {
      continue;
    }

    chunks.push({ type, id, data });
  }

  return { chunks, moduleMap };
}

/**
 * Creates a streaming encoder that can be fed chunks incrementally.
 * Returns an object with an encode() method and a drain() method.
 */
export function createFlightEncoder() {
  const chunks: FlightChunk[] = [];
  let moduleMap: Record<string, string> = {};

  return {
    addModule(id: number, moduleId: string, chunkPath: string): void {
      chunks.push({ type: 'M', id, data: moduleId });
      moduleMap[moduleId] = chunkPath;
    },

    addLazy(id: number, moduleId: string): void {
      chunks.push({ type: 'L', id, data: moduleId });
    },

    addData(id: number, data: unknown): void {
      chunks.push({ type: 'J', id, data });
    },

    addString(id: number, str: string): void {
      chunks.push({ type: 'S', id, data: str });
    },

    addError(id: number, error: Error): void {
      chunks.push({ type: 'E', id, data: { message: error.message, name: error.name } });
    },

    encode(): string {
      return encodeFlight({ chunks, moduleMap });
    },

    getPayload(): FlightPayload {
      return { chunks: [...chunks], moduleMap: { ...moduleMap } };
    },
  };
}

/**
 * Creates a streaming decoder that processes chunks as they arrive.
 * Useful for client-side hydration where chunks arrive over a network stream.
 */
export function createFlightDecoder() {
  let buffer = '';
  const chunks: FlightChunk[] = [];
  const moduleMap: Record<string, string> = {};

  return {
    push(data: string): FlightChunk[] {
      buffer += data;
      const newChunks: FlightChunk[] = [];
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        const colonIdx = line.indexOf(':');
        const secondColonIdx = line.indexOf(':', colonIdx + 1);
        if (colonIdx === -1 || secondColonIdx === -1) continue;

        const type = line.slice(0, colonIdx) as FlightType;
        const id = parseInt(line.slice(colonIdx + 1, secondColonIdx), 10);
        const dataStr = line.slice(secondColonIdx + 1);

        let dataValue: unknown;
        try {
          if (type === 'M' || type === 'L') {
            const parsed = JSON.parse(dataStr) as { moduleId: string; chunkPath?: string };
            dataValue = parsed.moduleId;
            // Reconstruct the module map from the wire — without this the
            // client can't resolve module references to chunk paths.
            if (parsed.chunkPath !== undefined) {
              moduleMap[parsed.moduleId] = parsed.chunkPath;
            }
          } else {
            dataValue = JSON.parse(dataStr);
          }
        } catch {
          continue;
        }

        const chunk = { type, id, data: dataValue };
        chunks.push(chunk);
        newChunks.push(chunk);
      }

      return newChunks;
    },

    getChunks(): FlightChunk[] {
      return [...chunks];
    },

    getModuleMap(): Record<string, string> {
      return { ...moduleMap };
    },

    getPayload(): FlightPayload {
      return { chunks: [...chunks], moduleMap: { ...moduleMap } };
    },

    isComplete(): boolean {
      return buffer === '';
    },
  };
}
