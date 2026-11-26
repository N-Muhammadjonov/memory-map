# AI readiness report

## Phase 0 inventory

| Area | Current implementation in V32 |
|---|---|
| Client | Vanilla JavaScript modules, HTML and CSS. The local Python application opens the default browser. |
| Server | Python 3.10+ standard-library HTTP server bound to loopback. The launcher supplies an authorization token in the URL fragment. Mutating routes validate the browser origin. CI builds with Python 3.12. |
| Packaging | PyInstaller configuration and a GitHub release workflow target Windows, macOS and Linux. The source launchers require Python. The repository contains no iPhone or Android packages. |
| Data | Local SQLite notes, metadata, attachments, markup and history. Vault records use AES-GCM. The vault key is derived from a password with Argon2id and can be recovered with a one-time key. |
| Sharing | Account transfer builds an encrypted ZIP from selected records. Markdown ZIP and brain exports serialize note content. Portable ZIP and backup previously copied the full vault database. |
| Public pages | A published note has an explicit snapshot at a slug. The same snapshot supports standalone HTML and hosted publishing. |
| AI and chat | There is no integrated chat. The optional AI Brain bridge is a separate loopback integration. V32 provider settings stored encrypted keys inside the vault and could send an explicit model-list request. |
| Statistics | Optional configured worker receives installation ID, build, platform, language, count buckets and feature/milestone labels. Ordinary statistics carry no note text or titles. The separate feedback form can send text, contact and optional screenshots. |

## Existing note commands

- `Vault.create_notes()` validates and writes one or more new notes.
- `Vault.update_note()` validates expected revisions and also handles moving a note to Trash.
- `Vault.append_to_note()` appends text. AI proposals stage the complete previewed change and use the revision-checked update path.
- `Vault._store()` snapshots the previous revision as part of every update transaction. `Vault.restore_history()` restores a previous revision.
- Editor links use stable `xotira:<id>` Markdown links through the ordinary note update path. `Vault.delete_trashed()` handles permanent deletion.
- Search and the local Brain bridge reuse the vault index. AI context needs its own allowlist boundary before retrieving any note.

## Risks and implementation plan

1. Add an offline mock and a provider interface. Leave real adapters disconnected.
2. Use the same authorization rules for all AI routes and keep developer mode disabled unless enabled at launch.
3. Use revisioned, expiring previews and explicit send confirmation. Do not auto-send tool results.
4. Gate every context and tool read by per-note visibility and password protection.
5. Use the vault commands and note history for approval and undo. Keep destructive tools unavailable.
6. Store AI records locally and filter them from copied vault snapshots. Move previously saved provider keys outside SQLite.
7. Keep credentials local and masked. Tests and mock mode require no real credentials or external requests.
8. Report desktop and browser verification separately. Mobile installation remains a separate packaging project.

Assumption: the attached V30 established the baseline. The V32 continuation preserves the file preview, annotation and code-runner changes already delivered to the owner.

## V33 acceptance evidence

- Python: 94 passing tests, including authentication, exact previews, stale revisions, approval and undo, encrypted credential migration, request deadlines, and privacy canaries.
- JavaScript: 59 passing tests, including streaming events, inert AI output, and consent withdrawal for optional usage counts.
- Local browser: unlock a fixture vault, enable Mock, preview and stream a request, approve and undo an edit, invoke the slash and selection entries, and review the three-note IELTS wizard proposal.
- Real providers remain disconnected. Native keychains and mobile installation have not been tested. The optional Worker migration was exercised against the local test database.
