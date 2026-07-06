/*
 * Telemetry-blocking classification (Settings → Block Facebook telemetry).
 *
 * The blocklist is anchored path prefixes matching EasyPrivacy's Facebook
 * filters — pure logging sinks only. NEVER add broad rules here: /api/graphql
 * (every messaging op), /ajax/bootloader-endpoint (lazy JS chunks — blocking
 * it white-screens), /ajax/bulk-route-definitions, /ajax/mercury/*,
 * /ajax/dtsg*, the edge-chat/gateway MQTT websockets, and rupload.facebook.com
 * (attachment uploads) must all stay reachable. Known gaps, accepted: worker/
 * service-worker-originated logs, <img> pixels, and telemetry riding inside
 * /api/graphql mutations.
 */
export const TELEMETRY_BLOCK_RE = new RegExp(
  [
    "^/ajax/bz(/|$)", // Banzai batch logging — the main telemetry firehose
    "^/a/bz(/|$)", // newer short Banzai alias
    "^/ajax/bnzai(/|$)", // legacy Banzai path
    "^/ajax/qm(\\.php)?(/|$)", // Quick Metrics performance beacons
    "^/common/scribe_endpoint(\\.php)?$", // legacy Scribe logging sink
    "^/security/hsts-pixel\\.gif$", // HSTS beacon
    "^/tr(/|$)", // Meta Pixel
    "^/ajax/error/", // browser JS-error reporting
  ].join("|"),
);

/** Whether a request URL (resolved against `base`) is a pure telemetry sink. */
export function isBlockedTelemetryUrl(raw: string | URL, base: string): boolean {
  let u: URL;
  try {
    u = new URL(raw, base);
  } catch (_) {
    return false; // fail open — never block what we can't classify
  }
  if (!/(^|\.)(facebook\.com|messenger\.com)$/.test(u.hostname)) return false;
  if (u.hostname === "pixel.facebook.com") return true;
  return TELEMETRY_BLOCK_RE.test(u.pathname);
}
