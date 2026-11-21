import { captureException } from "@sentry/react-native";
import { solNative } from "lib/SolNative";
import MiniSearch from "minisearch";
import { autorun, makeAutoObservable, runInAction } from "mobx";
import type { EmitterSubscription } from "react-native";
import type { IRootStore } from "store";
import {
	itemsToPrune,
	normalizeRetentionDays,
	pinnedFirst,
} from "./clipboard.retention";
import { readPersistedStore, writePersistedStore } from "./persisted-config";
import { Widget } from "./ui.store";

const MAX_ITEMS = 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const MANAGED_PASTEBOARD_IMAGES_PATH = `/Users/${solNative.userName()}/.config/sol/images_pasteboard`;

let onTextCopiedListener: EmitterSubscription | undefined;
let onFileCopiedListener: EmitterSubscription | undefined;
let pruneInterval: ReturnType<typeof setInterval> | undefined;

export type ClipboardStore = ReturnType<typeof createClipboardStore>;

export type PasteItem = {
	id: number;
	text: string;
	url?: string | null;
	bundle?: string | null;
	datetime: number; // Unix timestamp when last copied or pasted
	pinned?: boolean; // pinned items are never deleted automatically
};

type RankedPasteItem = PasteItem & {
	score?: number;
};

// Coarse relevance tier so the recency boost can only reorder items of
// comparable match quality, not let a fuzzy hit outrank a direct match.
const getMatchTier = (item: Pick<PasteItem, "text">, query: string) => {
	const q = query.trim().toLowerCase();
	if (!q) {
		return 0;
	}

	const text = item.text.toLowerCase();
	if (text.startsWith(q)) {
		return 0;
	}

	if (text.split(/\s+/).some((word) => word.startsWith(q))) {
		return 1;
	}

	return text.includes(q) ? 2 : 3;
};

const minisearch = new MiniSearch({
	fields: ["text"],
	storeFields: ["id", "text", "url", "bundle", "datetime"],
	// tokenize: (text: string, fieldName?: string) =>
	// 	text.toLowerCase().split(/[\s\.-]+/),
});

function isManagedPasteboardImagePath(path: string | null | undefined) {
	return !!path && path.startsWith(`${MANAGED_PASTEBOARD_IMAGES_PATH}/`);
}

function removeManagedImageFile(item: PasteItem | undefined) {
	if (!item?.url || !isManagedPasteboardImagePath(item.url)) {
		return;
	}

	try {
		if (solNative.exists(item.url)) {
			solNative.del(item.url);
		}
	} catch (e) {
		captureException(e);
	}
}

function cleanupOrphanedManagedImageFiles(items: PasteItem[]) {
	try {
		if (!solNative.exists(MANAGED_PASTEBOARD_IMAGES_PATH)) {
			return;
		}

		const referencedPaths = new Set(
			items
				.map((item) => item.url)
				.filter((path): path is string => isManagedPasteboardImagePath(path)),
		);

		const files = solNative.ls(MANAGED_PASTEBOARD_IMAGES_PATH);
		for (const fileName of files) {
			const fullPath = `${MANAGED_PASTEBOARD_IMAGES_PATH}/${fileName}`;
			if (!referencedPaths.has(fullPath) && solNative.exists(fullPath)) {
				solNative.del(fullPath);
			}
		}
	} catch (e) {
		captureException(e);
	}
}

export const createClipboardStore = (root: IRootStore) => {
	const store = makeAutoObservable({
		deleteItem: (item: PasteItem | undefined) => {
			const index = item ? store.items.findIndex((i) => i.id === item.id) : -1;
			if (index !== -1) {
				removeManagedImageFile(store.items[index]);
				minisearch.remove(store.items[index]);
				store.items.splice(index, 1);
			}
		},
		togglePin: (item: PasteItem | undefined) => {
			const target = item && store.items.find((i) => i.id === item.id);
			if (target) {
				target.pinned = !target.pinned;
			}
		},
		deleteAllItems: () => {
			store.items.forEach(removeManagedImageFile);
			store.items = [];
			minisearch.removeAll();
		},
		items: [] as PasteItem[],
		saveHistory: false,
		// Unpinned items older than this many days are deleted; 0 keeps them until MAX_ITEMS.
		retentionDays: 0,
		onFileCopied: (obj: {
			text: string;
			url: string;
			bundle: string | null;
		}) => {
			const newItem: PasteItem = {
				id: +Date.now(),
				datetime: Date.now(),
				...obj,
			};

			// If save history move file to more permanent storage
			if (store.saveHistory) {
				// TODO!
			}

			// const index = store.items.findIndex(t => t.text === newItem.text)
			// // Item already exists, move to top
			// if (index !== -1) {
			//   // Re-add to minisearch to update the order
			//   minisearch.remove(store.items[index])
			//   minisearch.add(newItem)

			//   store.popToTop(index)
			//   return
			// }

			// Item does not already exist, put to queue and add to minisearch
			store.items.unshift(newItem);
			minisearch.add(newItem);

			store.prune();
		},
		onTextCopied: (obj: { text: string; bundle: string | null }) => {
			if (!obj.text) {
				return;
			}

			const newItem: PasteItem = {
				id: Date.now().valueOf(),
				datetime: Date.now(),
				...obj,
			};

			const index = store.items.findIndex((t) => t.text === newItem.text);
			// Item already exists, move to top
			if (index !== -1) {
				// Re-add to minisearch to update the order
				minisearch.remove(store.items[index]);
				minisearch.add(store.items[index]);

				store.popToTop(store.items[index]);
				return;
			}

			// Item does not already exist, put to queue and add to minisearch
			store.items.unshift(newItem);
			minisearch.add(newItem);

			store.prune();
		},
		get clipboardItems(): PasteItem[] {
			const items = store.items;

			if (!root.ui.query || root.ui.focusedWidget !== Widget.CLIPBOARD) {
				return pinnedFirst(items);
			}

			// Boost recent items in search results
			const now = Date.now();
			const query = root.ui.query;
			const results = minisearch.search(query, {
				boostDocument: (_, __, storedFields) => {
					const dt =
						typeof storedFields?.datetime === "number"
							? storedFields.datetime
							: Number(storedFields?.datetime);
					if (!dt || Number.isNaN(dt)) return 1;
					// Boost items copied in the last 24h, scale down for older
					const hoursAgo = (now - dt) / (1000 * 60 * 60);
					if (hoursAgo < 1) return 1.2; // very recent
					if (hoursAgo < 24) return 1.1; // recent
					return 1;
				},
				prefix: true,
				fuzzy: true,
			}) as unknown as RankedPasteItem[];

			results.sort((left, right) => {
				const tierDiff = getMatchTier(left, query) - getMatchTier(right, query);
				if (tierDiff !== 0) {
					return tierDiff;
				}

				return (right.score ?? 0) - (left.score ?? 0);
			});

			// Return the live items (search results are copies of the indexed fields), so
			// pins show and actions on a result find the item it came from.
			const byId = new Map(items.map((item) => [item.id, item]));
			return results
				.map((result) => byId.get(result.id))
				.filter((item): item is PasteItem => item != null);
		},
		prune: () => {
			const drop = itemsToPrune(store.items, {
				retentionDays: store.retentionDays,
				maxItems: MAX_ITEMS,
				now: Date.now(),
			});
			if (drop.length === 0) {
				return;
			}

			for (const item of drop) {
				removeManagedImageFile(item);
				try {
					minisearch.remove(item);
				} catch (e) {
					captureException(e);
				}
			}
			const dropped = new Set(drop);
			store.items = store.items.filter((item) => !dropped.has(item));
		},
		setRetentionDays: (days: number) => {
			store.retentionDays = normalizeRetentionDays(days);
			store.prune();
		},
		// Moves an item to the top and counts it as used now, so retention keeps it.
		popToTop: (item: PasteItem | undefined) => {
			const index = item ? store.items.findIndex((i) => i.id === item.id) : -1;
			if (index === -1) {
				return;
			}
			const newItems = [...store.items];
			const [moved] = newItems.splice(index, 1);
			moved.datetime = Date.now();
			newItems.unshift(moved);
			store.items = newItems;
		},
		setSaveHistory: (v: boolean) => {
			store.saveHistory = v;
			if (!v) {
				solNative.securelyStore("@sol.clipboard_history_v2", "[]");
			}
		},
		cleanUp: () => {
			onTextCopiedListener?.remove();
			onTextCopiedListener = undefined;
			onFileCopiedListener?.remove();
			onFileCopiedListener = undefined;
			if (pruneInterval) {
				clearInterval(pruneInterval);
				pruneInterval = undefined;
			}
		},
	});

	onTextCopiedListener = solNative.addListener(
		"onTextCopied",
		store.onTextCopied,
	);
	onFileCopiedListener = solNative.addListener(
		"onFileCopied",
		store.onFileCopied,
	);

	const hydrate = async () => {
		const persistedState = await readPersistedStore<{
			saveHistory?: boolean;
			retentionDays?: number;
		}>("clipboard");

		if (persistedState) {
			store.saveHistory = persistedState.saveHistory ?? false;
			store.retentionDays = normalizeRetentionDays(
				persistedState.retentionDays,
			);
		}

		if (store.saveHistory) {
			const entry = await solNative.securelyRetrieve(
				"@sol.clipboard_history_v2",
			);

			if (entry) {
				let items = JSON.parse(entry);
				// Ensure all items have datetime
				items = items.map((item: any) => ({
					...item,
					datetime:
						typeof item.datetime === "number" && !Number.isNaN(item.datetime)
							? item.datetime
							: item.id || Date.now(), // fallback: use id or now
				}));
				runInAction(() => {
					store.items = items;
					minisearch.addAll(store.items);
					store.prune();
				});

				cleanupOrphanedManagedImageFiles(items);
			} else {
				cleanupOrphanedManagedImageFiles([]);
			}
		} else {
			cleanupOrphanedManagedImageFiles([]);
		}
	};

	const persist = async () => {
		if (store.saveHistory) {
			// Ensure all items have datetime before persisting
			const itemsToPersist = store.items.map((item) => ({
				...item,
				datetime:
					typeof item.datetime === "number" && !Number.isNaN(item.datetime)
						? item.datetime
						: item.id || Date.now(),
			}));
			try {
				await solNative.securelyStore(
					"@sol.clipboard_history_v2",
					JSON.stringify(itemsToPersist),
				);
			} catch (e) {
				console.warn("Could not persist data", e);
			}
		}

		const storeWithoutItems = { ...store };
		storeWithoutItems.items = [];

		try {
			writePersistedStore("clipboard", {
				saveHistory: storeWithoutItems.saveHistory,
				retentionDays: storeWithoutItems.retentionDays,
			});
		} catch {
			console.warn("Could not persist clipboard store config");
		}
	};

	hydrate().then(() => {
		// The whole history is written to the Keychain on every change; batch bursts of
		// changes (copies, pastes, pins) into one write.
		autorun(persist, { delay: 1000 });
		pruneInterval = setInterval(store.prune, PRUNE_INTERVAL_MS);
	});

	return store;
};
