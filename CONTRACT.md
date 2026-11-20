# Extension contract

## Host and project boundaries

OMOS queues uses OpenChamber SDK 2.7.1 and API version 1. Its identity is `omos-queues`. A single extension page uses SDK primitives, and a local Node service has the `opencode` execution capability. No host patches, external UI assets, or inference are required. The source manifest stays `private: true` to prevent npm publication. Build artifacts belong in ignored paths and are built locally, not uploaded by CI.

The service is not an operating-system sandbox. Its files live in `OPENCHAMBER_SERVICE_DATA_DIR`; they do not belong in the repository. Treat users with access to this extension's settings as trusted server operators.

## Service, file and draft safety

- The service binds to loopback and uses the host bearer token. It rejects Origin-bearing requests, returns no-store responses, and does not expose whole parsed configurations, unrelated prompts or raw errors. The frame uses the SDK bridge, not direct HTTP.
- Settings select one existing global OMOS JSONC or JSON file, one model-listing executable and its server context. A settings generation pins the resolved pathname. A different target, malformed file, duplicate keys, or an external edit invalidates review. Missing configuration must not block opening Settings or checking service health.
- Enumerate supported explicit preset, global agent and council-seat model values. Respect inheritance and reserved identities; unsupported values stay inspectable or read-only. Native OpenCode Build is not an OMOS queue. A supported Orchestrator first model is a preset default, not a promise about a running session.
- Stage edits before saving. A preview uses pinned target/generation/hash, exact changed-value diffs and an expiring immutable token. Commit accepts only that token. Recheck conflicts, create an exclusive same-directory backup and temporary file, and atomically replace only the reviewed file. Preserve untouched bytes. The last check is not kernel-atomic compare-and-swap against an uncooperative writer. Changed-value comments can be removed; show those removals in the diff. A lost acknowledgement requires explicit reconciliation, not an automatic retry.
- Use separate frame drafts with bounded storage. Offer recovery as a copy; stale drafts remain inspectable and are never silently merged. A late save acknowledgement must not erase newer edits. Show draft-persistence failures without discarding in-memory values.

## Optional metadata and UI

The model catalog is a bounded `opencode models` job. Catalog failure does not prevent manually editing an eligible queue. Instance favorites are separate from OMOS and profile favorites. The profile import source is read-only and applies only after confirmation; a stale or unavailable source is not an authoritative empty list. [Installed marketplace metadata and staged package operations](docs/MARKETPLACE-CONTRACT.md) share the same review and save transaction.

Keep manual pickers, review, and draft inspection usable within the extension viewport. Name the affected queue or preset, give full-size touch controls, keep review actions reachable, and preserve focus/draft state on cancel. Show real failures and reasons for blocked actions; prefer local feedback to repeating the same status in a banner. Report screenshot and browser coverage separately from physical device testing.

Use `bun run check` as the integrated local gate. Tests and captures use synthetic homes/stores/configuration; no automated test may save a real OMOS file, invoke a model, or change a shared host.
