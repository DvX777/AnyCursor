'use strict';

/**
 * Cursor sends analytics, metrics, traces and log uploads through the same
 * backend URL as inference. AnyCursor therefore sees them and, by default,
 * refuses to forward them. Only the path is recorded; request bodies and
 * headers are never written for blocked requests.
 *
 * Keep this list narrow. It must never match inference, catalog, auth or
 * dashboard calls; those are required for Cursor to work.
 */
const PATTERNS = [
  ['otlp', /^\/v1\/(?:traces|metrics|logs)(?:\/|$)/i],
  ['analytics', /^\/aiserver\.v1\.AnalyticsService\//i],
  ['online-metrics', /^\/aiserver\.v1\.OnlineMetricsService\//i],
  ['trace-spans', /^\/aiserver\.v1\.TraceService\//i],
  [
    'client-metrics',
    /^\/aiserver\.v1\.AiService\/Report(?:ClientNumericMetrics|ProcessMetricsV2|AiCodeChangeMetrics)(?:\/|$)/i,
  ],
];

/**
 * Statsig bootstrap is a feature-gate config fetch, not an upload. Its request
 * body is empty and Cursor uses the response to decide which features and
 * sidecars are available, so it stays forwarded.
 */
const ALLOW = [
  /^\/aiserver\.v1\.AnalyticsService\/BootstrapStatsig(?:\/|$)/i,
];

const state = {
  since: new Date().toISOString(),
  blocked: 0,
  byPath: Object.create(null),
  keys: 0,
};

function classify(pathname) {
  const clean = String(pathname || '').split('?')[0];
  if (!clean) return '';
  for (const pattern of ALLOW) {
    if (pattern.test(clean)) return '';
  }
  for (const [kind, pattern] of PATTERNS) {
    if (pattern.test(clean)) return kind;
  }
  return '';
}

function enabled(config) {
  return !(config && config.privacy && config.privacy.blockTelemetry === false);
}

function record(pathname) {
  state.blocked += 1;
  const key = String(pathname || '').split('?')[0].slice(0, 200);
  if (!key) return;
  if (!state.byPath[key]) {
    // Bound the map so a hostile client cannot grow it without limit.
    if (state.keys >= 64) return;
    state.keys += 1;
  }
  state.byPath[key] = (state.byPath[key] || 0) + 1;
}

function snapshot(config) {
  return {
    enabled: enabled(config),
    blocked: state.blocked,
    since: state.since,
  };
}

function paths() {
  return { ...state.byPath };
}

module.exports = { classify, enabled, record, snapshot, paths };
