/**
 * Keep API access logs bounded.  The dashboard payload can contain hundreds of
 * fixtures and thousands of quote cells; serializing it again in the response
 * logger blocks the single Node event loop and can turn a successful response
 * into a client timeout.  The response itself is unchanged.
 */
export function apiLogBody(path: string, body: unknown): unknown {
  if (path !== "/api/dashboard" || !body || typeof body !== "object") return body;
  const dashboard = body as {
    matches?: unknown;
    status?: { refreshing?: unknown; mode?: unknown; degradedReason?: unknown };
  };
  const matches = Array.isArray(dashboard.matches) ? dashboard.matches : [];
  const lineCount = matches.reduce((total, match) => {
    const lines = match && typeof match === "object" && Array.isArray((match as { lines?: unknown }).lines)
      ? (match as { lines: unknown[] }).lines.length
      : 0;
    return total + lines;
  }, 0);
  return {
    dashboard: true,
    matches: matches.length,
    lines: lineCount,
    refreshing: Boolean(dashboard.status?.refreshing),
    mode: dashboard.status?.mode ?? null,
    degraded: Boolean(dashboard.status?.degradedReason),
  };
}
