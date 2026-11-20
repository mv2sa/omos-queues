# Contributing

Open an issue for a bug or proposed change, or send a focused pull request from a fork. For bugs, include the OpenChamber and OpenCode versions, the expected and actual behavior, and steps to reproduce it with a synthetic file. For visual issues, name the browser and whether it was a physical device or emulation. Do not post real model configuration, account data, credentials, backups, or unredacted logs.

Use the Node and Bun versions listed in the [README](README.md), then run:

```sh
bun install --frozen-lockfile
bun run check
```

The check covers builds, syntax, unit tests, the SDK manifest, and a deterministic local install ZIP. Run a focused backend or page suite while iterating. If your change crosses the host bridge, use the [isolated Firefox harness](test/integration/README.md) with synthetic settings and configuration. Do not attach generated bundles, ZIPs, receipts or development captures to a source PR.

Keep the extension manual-only and use the public OpenChamber SDK. No host patches, paid model calls, new config write paths, or added capabilities are needed for ordinary contributions. Preserve the existing review, conflict, backup, unknown-save and draft recovery behavior. See the [extension contract](CONTRACT.md) and [marketplace contract](docs/MARKETPLACE-CONTRACT.md).

For a security issue, use the repository's private vulnerability reporting if available. If it is unavailable, contact a maintainer privately instead of posting reproduction details or private files on an issue.
