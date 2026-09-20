/**
 * Parses a `--port` value. `parseInt('abc')` is NaN, which the HTTP server
 * would either reject with an obscure error or (for NaN) bind a random port,
 * so reject anything that is not an integer in 0-65535 up front.
 */
export function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`Invalid --port "${raw}": expected an integer between 0 and 65535.`);
  }
  const port = Number.parseInt(raw, 10);
  if (port > 65535) {
    throw new Error(`Invalid --port "${raw}": expected an integer between 0 and 65535.`);
  }
  return port;
}
