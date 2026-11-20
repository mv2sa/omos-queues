# Isolated host and browser proof

The extension targets SDK 2.7.1, API version 1. This harness installs the built package in an isolated stock OpenChamber host, approves only its service capability and drives the real page with Firefox. It records the host version actually used. It never installs into the normal host or edits a real OMOS configuration.

## Run

Build with `bun run build`. For combined acceptance, use a Node runtime supported by the installed host (for example, Node 24.14 or later for OpenChamber 2.7.3). Point the runner at the package root containing `package.json`; it resolves the stock CLI from `bin.openchamber`. Supply the OpenCode executable, Firefox, and the built extension:

```sh
node test/integration/host-smoke.mjs \
  --host-root /path/to/@openchamber/web \
  --opencode /path/to/opencode \
  --firefox /usr/bin/firefox --package . --marketplace \
  --output /tmp/opencode/omos-queues-proof
```

The default without `--marketplace` omits the installed-package flow. `--skip-ui` runs only the service proof. `--focus-marketplace` (with `--marketplace`) and `--focus-secondary` are diagnostic subsets, not combined acceptance. `--focus-layout` samples one fixed, three-position queue at desktop and phone sizes: use the same harness and synthetic IDs against both packages, then compare `layout[].height` only when the recorded viewport, model font and root font match. Model selection has no inference or provider fixture.

For a Firefox-only preflight use `node test/integration/browser.mjs --self-test --firefox /usr/bin/firefox --output /tmp/opencode/omos-browser-proof`. The Node 22 BiDi driver uses an owned Firefox profile. On Ubuntu it resolves the Firefox snap wrapper to the stock binary inside its mount; it does not install a driver or download a browser.

## What to inspect

- **Isolation and service.** A unique synthetic HOME, XDG and `OPENCHAMBER_DATA_DIR` isolate each loopback host. Before writes the host must have no extensions or sessions. Installation and approval use the real host API. A synthetic `opencode models` stub lists deterministic IDs and refuses other commands. The service proof loads the pinned scratch config, previews, commits once, creates a backup, rejects replay and conflicts, and stores/removes a separate draft.
- **Manual editor.** Drive the installed page, not a mocked bridge. Check continuous queue order, desktop/phone jump controls, focus after navigation, and a full-viewport model dialog that survives resizing. Verify partial search, typed IDs and one useful hint on an incomplete no-match search. Copy feedback stays on the button. Cancel and confirm Paste: verify the exact copied positions, preserved destination default and unchanged file and backup counts. With two dirty queues, resetting one must keep the other intact. Check the diff and file/backup counts before and after confirming a save. On the emulated phone, verify the full-screen review at normal and short heights, both scroll axes with fixed actions, and Back without writing. Inspect a stored draft full screen and return to the same draft's Inspect control. Recover a copy without deleting its source; exercise unknown-save reconciliation where the host exposes the commit response boundary. Settings and Reload remain reachable.
- **Primary agents.** Uneditable Build is absent from the workspace and jumps. A supported existing preset can receive an Orchestrator first model without connecting a marketplace source. Cancel stages nothing; the v3 draft survives reopening and may be explicitly recovered. Confirmation changes just the reviewed model in the file and creates one backup.
- **Favorites.** Change the synthetic stock host’s profile through its own settings API and verify that fresh reads observe ordered additions, removals and an explicit empty list. Toggle stars through actual page controls, verify saved order and a reopened picker through SDK storage, and test source/import success, failure, cancel and explicit clear. Refreshing a source must not replace local favorites, save a queue, or lose a draft.
- **Marketplace.** Use a synthetic verified installed store and both flat/structured presets. Stage package selection, keep one package inherited, choose another package’s first model, and edit an ordinary queue. Recover the v2 draft; cancel the combined review without writes and confirm it with exactly one backup. Check store bytes, retained opaque selections, stale source refusal/recheck and target-file conflict. No package installation, activation or provider calls.
- **Screens and receipts.** Capture actual light/dark desktop and emulated phone workspaces, manual picker, review and error states. `result.json` records stage outcomes, artifact hashes, page/style/service/manifest identities, and cleanup. Failed runs remain failures. Keep raw captures, logs and receipts out of source control.

Physical Android Firefox, its real soft keyboard and other platforms are **not** qualified by emulation. Use an isolated host and explicitly synthetic configuration for a separate device check. Never point the automated write cases at a live file, call a model, change shared services, or sweep unrelated temporary files.
