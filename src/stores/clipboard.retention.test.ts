import { describe, expect, test } from "bun:test";
import {
	DAY_MS,
	itemsToPrune,
	normalizeRetentionDays,
	pinnedFirst,
} from "./clipboard.retention";

const now = 1_000 * DAY_MS;
const item = (id: number, ageDays: number, pinned = false) => ({
	id,
	datetime: now - ageDays * DAY_MS,
	pinned,
});
const ids = (items: Array<{ id: number }>) => items.map((i) => i.id);

describe("itemsToPrune", () => {
	test("drops unpinned items older than the retention period", () => {
		const items = [item(1, 0), item(2, 3), item(3, 8), item(4, 30)];
		expect(
			ids(itemsToPrune(items, { retentionDays: 7, maxItems: 1000, now })),
		).toEqual([3, 4]);
	});

	test("keeps pinned items however old", () => {
		const items = [item(1, 0), item(2, 400, true), item(3, 8)];
		expect(
			ids(itemsToPrune(items, { retentionDays: 7, maxItems: 1000, now })),
		).toEqual([3]);
	});

	test("retention 0 never drops by age", () => {
		const items = [item(1, 0), item(2, 5000)];
		expect(
			itemsToPrune(items, { retentionDays: 0, maxItems: 1000, now }),
		).toEqual([]);
	});

	test("over the cap, drops the oldest unpinned items and skips pinned ones", () => {
		const items = [item(1, 0), item(2, 1), item(3, 2, true), item(4, 3)];
		expect(
			ids(itemsToPrune(items, { retentionDays: 0, maxItems: 2, now })),
		).toEqual([2, 4]);
	});

	test("age and cap together don't double count", () => {
		const items = [item(1, 0), item(2, 1), item(3, 2), item(4, 10)];
		// 4 is too old; that leaves 3 items for a cap of 2, so 3 goes too.
		expect(
			ids(itemsToPrune(items, { retentionDays: 7, maxItems: 2, now })),
		).toEqual([3, 4]);
	});

	test("more pinned items than the cap: pinned all stay", () => {
		const items = [item(1, 0, true), item(2, 1, true), item(3, 2)];
		expect(
			ids(itemsToPrune(items, { retentionDays: 0, maxItems: 1, now })),
		).toEqual([3]);
	});
});

describe("pinnedFirst", () => {
	test("pinned items first, both groups keep their order", () => {
		const items = [item(1, 0), item(2, 1, true), item(3, 2), item(4, 3, true)];
		expect(ids(pinnedFirst(items))).toEqual([2, 4, 1, 3]);
	});

	test("returns the same array when nothing is pinned", () => {
		const items = [item(1, 0), item(2, 1)];
		expect(pinnedFirst(items)).toBe(items);
	});
});

describe("normalizeRetentionDays", () => {
	test("accepts positive numbers, everything else means never", () => {
		expect(normalizeRetentionDays(7)).toBe(7);
		expect(normalizeRetentionDays("30")).toBe(30);
		expect(normalizeRetentionDays(undefined)).toBe(0);
		expect(normalizeRetentionDays(-1)).toBe(0);
		expect(normalizeRetentionDays("abc")).toBe(0);
	});
});
