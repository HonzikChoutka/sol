# Personal fork of Sol

Upstream: [ospfranco/sol](https://github.com/ospfranco/sol). This fork isn't meant for pull requests.

## What's different

- **Pinned clipboard items.** In the clipboard view, ⌘P pins or unpins the selected item. Pinned items stay at the top and are never deleted automatically.
- **Clipboard retention.** Settings → General → *Delete unpinned clipboard items*: never, 1 day, 1 week, 1 month or 3 months, counted from when an item was last copied or pasted. Unpinned items are pruned on launch, on every copy, and hourly.
- **Batched history writes.** History is written to the Keychain at most once a second instead of on every change.
- **No auto-updates.** Sparkle is off, so upstream releases can't replace this build.

## Build and install

```sh
scripts/build-fork.sh            # build only
scripts/build-fork.sh --install  # build, then replace /Applications/Sol.app
```

The first install keeps the official app at `~/.local/share/sol-fork/Sol-upstream.app`. Each install moves the build it replaces to `~/.local/share/sol-fork/Sol-previous.app`.

After the first install, macOS treats this build as a different app:

- Grant Accessibility (and Calendar) again in System Settings → Privacy & Security.
- Allow Keychain access once ("Always Allow") so the fork can read your existing clipboard history.

## Tests

```sh
bun test src/stores
```

## Pulling upstream changes

```sh
git fetch upstream && git merge upstream/main && scripts/build-fork.sh --install
```
