// Shared runtime counters for the content script. A single mutable object that
// every module increments directly; the entry point exposes it via
// window.__ylctStats() for debugging.

export interface Stats {
  seen: number;
  japanese: number;
  korean: number;
  noise: number;
  skip: number;
  pending: number;
  done: number;
  error: number;
  cacheHits: number;
  hidden: number;
  self: number;
  dedupHits: number;
  sampled: number;
}

export const stats: Stats = {
  seen: 0, japanese: 0, korean: 0, noise: 0, skip: 0,
  pending: 0, done: 0, error: 0,
  cacheHits: 0, hidden: 0, self: 0,
  dedupHits: 0, sampled: 0,
};
