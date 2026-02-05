// Minimal snapshot helper for now; will be expanded when ECS is implemented
export function createSnapshot<T>(state: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(state) as T;
  }
  // Fallback shallow deep-copy via JSON (acceptable for early dev snapshots)
  return JSON.parse(JSON.stringify(state)) as T;
}
