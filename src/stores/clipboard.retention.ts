// Pure rules for clipboard history: which items survive, and the order they are shown in.
// Kept free of React Native / MobX imports so they can be unit tested with `bun test`.

export type RetainedItem = {
	id: number;
	datetime: number; // last copied or pasted (ms)
	pinned?: boolean;
};

export const DAY_MS = 24 * 60 * 60 * 1000;

// 0 means "never delete by age".
export const RETENTION_OPTIONS: Array<{ label: string; value: number }> = [
	{ label: "Never", value: 0 },
	{ label: "After 1 day", value: 1 },
	{ label: "After 1 week", value: 7 },
	{ label: "After 1 month", value: 30 },
	{ label: "After 3 months", value: 90 },
];

export function normalizeRetentionDays(value: unknown): number {
	const days = Number(value);
	return Number.isFinite(days) && days > 0 ? days : 0;
}

/**
 * Items to drop: unpinned items older than `retentionDays` (if set), then the oldest
 * unpinned items beyond `maxItems`. `items` is newest first. Pinned items are never dropped.
 */
export function itemsToPrune<T extends RetainedItem>(
	items: T[],
	options: { retentionDays: number; maxItems: number; now: number },
): T[] {
	const { retentionDays, maxItems, now } = options;
	const cutoff = retentionDays > 0 ? now - retentionDays * DAY_MS : -Infinity;

	const drop = new Set<T>();
	for (const item of items) {
		if (!item.pinned && item.datetime < cutoff) {
			drop.add(item);
		}
	}

	let excess = items.length - drop.size - maxItems;
	for (let i = items.length - 1; i >= 0 && excess > 0; i--) {
		const item = items[i];
		if (!item.pinned && !drop.has(item)) {
			drop.add(item);
			excess--;
		}
	}

	return items.filter((item) => drop.has(item));
}

/** Display order: pinned items first, each group keeping its existing (newest first) order. */
export function pinnedFirst<T extends RetainedItem>(items: T[]): T[] {
	const pinned = items.filter((item) => item.pinned);
	if (pinned.length === 0) {
		return items;
	}
	return [...pinned, ...items.filter((item) => !item.pinned)];
}
