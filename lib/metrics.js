'use strict';

// Simple in-memory counters for /api/metrics. Reset on process restart;
// for cross-restart aggregation, scrape and forward to your own store.
// Exported as a shared singleton so the auth middleware, routes and the
// WebSocket handler all mutate the same counters.
const bootTime = Date.now();
const counters = {
    requests_total: 0,
    auth_failures_total: 0,
    origin_blocked_total: 0,
    rate_limited_total: 0,
    sessions_created_total: 0,
    sessions_stopped_total: 0,
    ws_connections_total: 0,
    ws_active: 0,
};

module.exports = { bootTime, counters };
