type EvidenceGlobal = typeof globalThis & { __subtestProcessedEventIds?: Set<string> };
const root = globalThis as EvidenceGlobal;
const ids = root.__subtestProcessedEventIds ?? (root.__subtestProcessedEventIds = new Set<string>());

export function recordProcessedEvent(id: string) {
  ids.add(id);
}

export function processedEventIds(): string[] {
  return [...ids];
}
