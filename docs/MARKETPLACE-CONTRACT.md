# Staged marketplace configuration

## Scope

The editor can stage selection of verified installed packages and optional model overrides. It never installs packages or enables the marketplace itself.

A user may stage installed-package selections and optional explicit agent model ladders in an **existing global-file preset**, review one narrow combined diff, cancel without writing, or confirm one existing token-only atomic save. Existing queue edits may join the same transaction. No second writer or separate activation/save call.

No package download/install/update/uninstall, preset creation, active-preset change, master-enable change, project-layer edits, prompts, permissions, skills, MCP definitions, executable/network settings or automatic reload. Selecting an installed package uses its existing definition when OMOS next activates that preset; it is not live admission.

Marketplace mutation supports unambiguous structured or flat presets without `extends`, `marketplace.agents_add` or `agents_remove`. Unsupported cases have a reason; ordinary existing model editing remains available. A legacy custom agent named `marketplace` must not be overwritten as activation configuration.

Raw selection is **`presets.<preset>.marketplace.agents`**. `marketplacePresets` is runtime-derived and must never be persisted. Root `marketplace` only has the master switch; root `marketplace.agents` is not a fallback. New model paths are backend-derived from a verified package's agentName: structured `presets.<preset>.agents.<agent>.model` or qualified flat equivalent.

Keeping package/session inheritance creates no model node. Explicit ladders use existing literal-ID/variant rules and1–50 nonempty positions, not invented defaults or empty arrays. Reject identity collisions, unsafe existing custom definitions, root overrides shadowing a new preset override, overlapping model edits, and orphaning deselections. Never silently delete an override or unknown selection. Unknown already-selected IDs may only be retained unchanged; new selections require verified installed identity. Packages extending built-ins are shown blocked in this first slice.

## Read-only installed metadata

Do not import/call OMOS store code: even `.list()` reconciles/writes under a lease. No host-internal runtime imports or new dependency. Implement a versioned reader with an explicitly configured root, initially disconnected.

- Authority: `<root>/lock.json`, exact `schemaVersion:2`, `packages[id]` with `manifestSchemaVersion`, canonical `manifestVersion`, source metadata and `{algorithm,domain,value}` digest.
- Bundle: `<root>/packages/<publisher>/<name>/<manifestVersion>/package.json`, wrapper `{manifest:...}`, plus the same directory's `sha256` sidecar. The lock selects the version; never scan for newest versions.
- Manifest schema2 uses domain `marketplace-agent-bundle-v2`; schema3 uses `marketplace-agent-bundle-v3`. Algorithm `sha256`. Hash the whole parsed bundle by recursively sorting object keys in UTF-16 code-unit order and JSON-encoding primitives/arrays without whitespace, not raw file bytes. Compare computed digest, lock and sidecar. Never expose package prompts/tools/MCPs/content.
- Package ID: `^[a-z0-9][a-z0-9._-]{0,63}/[a-z0-9][a-z0-9._-]{0,63}$`; agent name: `^[a-z][a-z0-9_-]{0,63}$`. Reject traversal components, prototype-reserved identities, duplicate package/agent identities and unsafe builtin collisions. Protected OMOS identities include orchestrator/council/councillor as well as the extendable specialist names; the extendable-target set is not the complete protected-name set. Canonical exact semver only, max128 characters.
- Bounds: lock2MiB,64 packages, bundle512KiB, sidecar128 bytes, aggregate8MiB, nesting64. Refuse overflow, do not truncate. At most256 described presets,64 selections/creations per edited preset and64 preset edits per request, within the existing256KiB body bound.
- Reject duplicate JSON keys, unknown schemas/domains, nonregular files/FIFOs, symlink components, escaped paths and changing file identities/content. OMOS retains `marketplace.lock` as a lease-container directory: absent or verified empty is valid. Scan at most128 entry metadata records; malformed/nonregular/nonempty entries, symlinks, live or uncertain leases are unavailable. Mirror the60-second protocol read-only: an aged candidate may be ignored; an aged lease may be ignored only when signal0 proves its bounded positive PID absent (`ESRCH`). Other process-inspection failures stay fail-closed. Never unlink/repair entries or expose their ownership tokens. Recheck container and entry identities before/after, plus root/components and authority/file identities before publishing.
- This verifies installed metadata integrity, not full runtime admission. Project identity/display/model-source/digest and fixed blocked reasons only. `modelSource` is `session|orchestrator|explicit|builtin`; do not expose package candidates or package content.

Module `src/backend/marketplace-source.js` exports `createMarketplaceSourceStore({dataDir,now})` with `.get()`→`{rootPath,generation}`, `.update(rootPath)`→same, `.snapshot()`→fresh DTO, following the favorites-source convention. Persist only `marketplace-source.json` in private service data; core settings stay exactly four fields. Export a pure canonical digest helper and `readMarketplaceSnapshot` for synthetic tests.

Ready DTO:

```js
{state:'ready',adapterVersion:'omos-marketplace-lock-v2',generation,fingerprint,readAt,
 packages:[{id,version,agentName,displayName,modelSource,digest,blockedReason}]}
```

`digest` is64-character hex; blockedReason is null or fixed text. Unready `not-configured|unavailable|unsupported` carry generation/error and **no authoritative packages array**. Fingerprint only stable safe package projection and verified digests, not paths/source URLs/formatting/timestamps. Generation separately fences source reconfiguration. No perfect cross-file CAS exists with an independently changing store; document the residual race.

## Service and pure projection

All new routes inherit existing bearer/Origin/no-store/size/sanitized-error rules. Bad marketplace metadata never blocks health or ordinary editing.

- GET `/marketplace/source`→`{rootPath,generation}`; POST accepts exactly `{rootPath}` (absolute or empty), persists extension-private settings only.
- GET `/marketplace/snapshot`→fresh adapter DTO.
- GET `/marketplace/config`→`{target,baseHash,catalog,masterEnabled,activePreset,presets}`. Reads pinned selected file plus fresh catalog, changes nothing. activePreset is an existing literal file value or null, never guessed/set.
- Each preset: `{name,layout,editable,reason,selectionPresent,packageIds,agents}`. layout=`structured|flat|unsupported`; agents are `{packageId,agentName,selected,existingGroupId,modelPath,defaultVariant,canCreate,blockedReason}`. Paths are derived or null. `defaultVariant` is the existing literal preset-agent default (or empty); unresolved/unsupported defaults block creation rather than being invented. Retain unknown selected IDs with blocked metadata. These are configuration/installed views, not claimed effective live agents.
- Backend export `describeMarketplaceConfig({text,groups,catalog})` returns `{masterEnabled,activePreset,presets}` without I/O. Root master disabled/unsupported source/preset shapes prevent marketplace staging with a reason. Ordinary GET `/config` shape remains unchanged.

## One preview and commit

Existing `/preview` bodies remain valid. Optional strict addition:

```js
marketplace:{sourceGeneration,catalogFingerprint,
 edits:[{preset,packageIds,creations:[{packageId,models}]}]}
```

`changes` remains present and may be empty. Provided marketplace input needs at least one preset edit, no duplicate presets/packages/creations. Unchanged selection with no creation is a no-op. Creation requires its package selected in the resulting same-preset selection, matching fresh verified identity and no existing model node. Reject overlap with ordinary changes. No caller-chosen creation paths.

Canonical package IDs may be129 characters; this is separate from the128-character preset/version bounds. Previously selected opaque IDs may be retained as safe strings up to500 characters, but never grant new-selection or creation authority. Enforce the64-selection limit on the resulting list after unknown retention, not only on the submitted list. New selections must pass config-local custom/root identity collision checks even when no model queue is being created.

Extend `prepareConfigEdit({text,groups,changes,marketplace,marketplaceCatalog})` without changing ordinary behavior. Return existing fields plus `marketplaceBinding` (null or `{sourceGeneration,catalogFingerprint}`) and safe creation metadata for acknowledgment. New pure planner lives in `marketplace-config.js`; internal shared-validation refactoring is permitted without cycles/drift.

For marketplace preview requests the public `/preview` response exposes the additive `marketplaceBinding` from the prepared result, so the page can verify the reviewed source binding. It is null for a semantic marketplace no-op; omit the field for legacy requests. An entirely no-op request still has no usable preview token. Do not rely on unspecified creation-ack fields: after an acknowledged save the page may hydrate GET `/config` (and the marketplace projection) while fencing stale responses and preserving newer local edits.

Apply all edits to one reviewed buffer. Verify the whole parsed result against an independently constructed expected document and audit allowed edit spans/untouched value slices. Only exact selection/model values plus necessary insertion punctuation/whitespace may change. Diff blocks use exact before/after AST slices. Absent nodes have explicit creation/path labels and empty before values, never surrounding parents/private neighbors. Existing diff limits remain.

Immutable previews retain source binding alongside target/hash/output. The existing committer gains a default-no-op internal `validatePreview(record)` hook, invoked before backup and immediately before replacement inside the serialized boundary. Server supplies fresh generation/fingerprint validation for bound records. Invalid bindings revoke/refuse the token; no partial apply. `/commit` remains token-only and existing backup/temp/fsync/rename/CAS semantics remain. Ordinary records perform no source I/O.

Run the second source guard before the final target-byte read/comparison, so an external target change during source validation is refused rather than overwritten. The unavoidable interval after that final comparison is still not kernel-atomic cross-process CAS.

## Drafts and UI acknowledgment

Keep v1 drafts readable/recoverable unchanged. Store v2 separately in `drafts-v2.json`, never through legacy filtering or automatic migration. Existing `.list/.save/.remove` returns a merged version-aware view. V2 overlays an older same-frame v1 UUID; promoted frames continue v2 even if marketplace edits later become empty. Explicit acknowledged deletion handles both copies without claiming success after partial failure. Preserve unknown versions inspect-only or refuse mutation safely; never drop them. Existing total bounds remain shared.

V2 adds `version:2`, nonnegative safe `revision`, and `marketplace` containing source binding, edits, selection originals with **absent-versus-empty distinction**, and bounded safe identities `{id,version,agentName,digest}` for recovery checks. Marketplace may be null for promoted ordinary-only drafts. Require at least one staged operation. Store no raw documents/package content/prompts/credentials/URLs.

Recovery stages only. Target/hash mismatch or changed package identity blocks marketplace recovery for explicit inspection/restaging; no auto-enable, silent path reinterpretation or catalog rebind. An explicit recheck may update source generation only when relevant installed identities are unchanged; otherwise restage. Dirty/preview/reconcile/late-ACK transitions include all operations and a shared revision. Clear only the acknowledged revision, preserving newer edits.

Show installed agents at the end of the continuous editor alongside Orchestrator, with an explicit existing-preset view shortcut, selected/inherited/staged labels and normal compact model controls. Source-folder controls live in Settings, not a separate management application. Choosing an override stages a valid model through the full-page manual picker, not an empty array. Treat a package that would register OpenCode's native `build` identity as a collision, not as a route to editing Build. Primary preset creation is independent of marketplace availability; its separate eligibility and common transaction are specified in CONTRACT.md.

## Acceptance

Use only synthetic stores/configs and isolated HOME/XDG/OPENCHAMBER_DATA_DIR. Source tests cover canonical digest, schema/identity/bounds, source error vs empty, symlinks/FIFOs/traversal, stale/changed files, private-content canaries and zero source writes. Transaction tests cover mixed selections/creations/models, semantic/byte preservation, unsupported shapes/collisions/orphans, stale source at preview/commit, replay/conflict/backup failures, v1/v2 recovery and unknown-save/late-ACK behavior.

Focused source: `node --test test/backend/marketplace-source.test.mjs`. Transaction: `node --test test/backend/marketplace-config.test.mjs test/backend/marketplace-transaction.test.mjs test/backend/marketplace-drafts.test.mjs test/backend/config.test.mjs test/backend/commit-faults.test.mjs`. UI: `node --test test/page/*.test.mjs`. Use `bun run check` for the integrated gate, and the [isolated host harness](../test/integration/README.md) for host and browser coverage. No live OMOS save or reload in automated acceptance.
