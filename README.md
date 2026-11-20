# OMOS queues

An unofficial [OpenChamber](https://github.com/openchamber/openchamber) extension for editing model fallback queues in a global [oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim) configuration.

- Pick a model from search, type a `provider/model` ID, or use a favorite. Set per-position variants and reorder positions manually.
- Copy, paste or reset one queue without changing the saved file. Recover a stored draft as a copy.
- Review the diff before saving. A confirmed save checks for concurrent changes and retains a backup next to the file.
- Stage a first Orchestrator default in a supported existing preset or edit [selections and overrides for installed marketplace agents](docs/MARKETPLACE-CONTRACT.md). Native OpenCode Build is not managed here.

There is no AI optimizer, automatic save, package installation from the editor, or OpenCode reload. The model catalog comes from `opencode models`; the extension does not ask a model to generate a response.

## Build and install

You need OpenChamber 2.7.1 or later with local extension services allowed, OpenCode, and an existing global OMOS JSONC or JSON file. The build and tests use Node 22.22.1 and Bun 1.3.14; use a Node runtime supported by your installed OpenChamber to run the host itself.

Clone this repository or download its source, then run in that directory:

```sh
bun install --frozen-lockfile
bun run check
```

The check builds and tests the extension and produces `dist/omos-queues-<version>.zip`. In OpenChamber, go to **Settings → Extensions**, upload the local ZIP, and approve the extension's service capability if you trust the code and intend to use it. OpenChamber does not build a cloned source repository. This repo has no published install packages or release builds; do not install `main` as a Git extension.

Open **OMOS queues → Settings** to confirm the global config path and OpenCode executable. If model enumeration needs a particular server working directory or OpenCode configuration directory, set those explicitly. A global preset default is not necessarily the effective model of a running session; project configuration can override it.

**Trust boundary:** the service runs with the connected OpenChamber server user's permissions. It is not a sandbox. Its settings choose which server files to read or edit and which executable to run with the `models` argument. Only enable it where everyone who can operate it is trusted with that access. Files, favorites and drafts are scoped to that server instance.

## Editing and saving

Search, Copy, Paste and Reset operate on the draft. **Review changes** opens the diff across the extension viewport. **Confirm and save** applies only the reviewed edits. Comments inside replaced values can be removed and are shown in the diff; unrelated file content stays intact. If a save outcome is unknown, check the file through the editor before trying again. A successful save does not reload OpenCode.

Favorites are local to the extension on the connected instance. You can optionally preview a read-only import from your OpenChamber profile; refreshing that preview does not replace stars. Marketplace configuration is likewise optional and does not install agents.

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md) for running checks and writing a useful issue or pull request. The [technical contract](CONTRACT.md) describes the write boundaries. Browser emulation is not a physical-device test.

See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
