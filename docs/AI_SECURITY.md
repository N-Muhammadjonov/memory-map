# AI security and migration

## Credentials by platform

The desktop application uses an encrypted local file on macOS, Windows and Linux. Its name is the vault name followed by .ai-credentials. The existing vault password derives the wrapping key. Ciphertext is bound to the vault identity. Credentials use atomic replacement and private temporary file permissions on systems that support them. Native OS keychain integration and mobile packages are future work. A missing or damaged credential file leaves ordinary vault use available.

The credentials API reports configured provider IDs. Keys stay masked and the input clears after saving. The distribution ships with no user credentials.

## Upgrade and rollback

V32 keys were encrypted in SQLite metadata. When legacy keys exist, V33 creates a local sanitized recovery snapshot called <vault>.pre-ai-storage.xotira. It then writes the encrypted sidecar and removes the legacy records with SQLite secure deletion enabled. A retry preserves newer sidecar values. An old V32 backup may still contain its encrypted credential record.

When recovering a vault password, the service stages a sidecar record for both the old and new cipher before committing the database rekey. The next successful unlock compacts the sidecar. A damaged or inaccessible sidecar leaves notes recoverable and may require re-entering credentials.

For rollback, close V33 and open the pre-upgrade snapshot as a separate vault, or open a regular V33 encrypted backup in V32. The SQLite schema version stays compatible. Re-enter credentials separately if needed. Sanitized backups omit AI settings, proposals, audit records, counters and legacy keys. Per-note exclusion flags stay with the encrypted vault backup to retain privacy choices.

## Content boundaries

- The AI workflow uses authenticated browser-origin requests and a dedicated local review path.
- Password-protected and explicitly excluded notes are omitted from AI context and Brain API search. Ordinary local note search keeps its usual scope.
- The preview binds note versions, privacy, settings, prompt and tool schemas. Notes and excerpts are marked as untrusted. The tool gate limits access to the previewed scope. Destructive tools are disabled.
- The audit includes dates, provider identifiers, operation names and token counts. Prompts, titles, note text, model output, keys and tool arguments are absent.
- Portable/vault snapshots are sanitized. Markdown and account-transfer ZIPs use explicit note and attachment fields. Public pages use the published note's snapshot.
- Owner AI statistics require both general telemetry consent and the separate AI counts switch. Only request and approval counts are shared. The admin dashboard displays aggregate monthly totals. The updated Worker requires stats-worker/migrations/0002_ai_counts.sql for existing databases.
- The Mock is local. The future direct adapter connects the device only to the selected provider. Hosted proxy mode remains a separate decision.
