/**
 * timer.js — minimal high-resolution timer for measuring tool call durations.
 */

/**
 * A high-resolution timer that returns elapsed time in milliseconds on stop().
 */
export function hrtime() {
  const start = process.hrtime.bigint();
  return {
    /** Returns elapsed milliseconds since creation. */
    stop() {
      const end = process.hrtime.bigint();
      return Number(end - start) / 1e6;
    },
  };
}

/**
 * Format a duration (in milliseconds) for display.
 * e.g. "12ms", "1.23s", "0.5s"
 */
export function formatDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Format token count with comma separators.
 * e.g. "1,234"
 */
export function formatTokens(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
