# Memory map public release

The desktop application is local-first. The Python service is bound to loopback
and each launch has its own authorization token. The public Vercel website only
hosts download and privacy pages.

## Services

- Website: https://memory-map-ecru.vercel.app/
- Source and releases: https://github.com/N-Muhammadjonov/memory-map
- Anonymous analytics and submitted feedback: Cloudflare Worker and D1.
- Optional identity: a separate Supabase Auth project; this is independent of the
  encrypted local vault. Do not use an existing unrelated application database.

Public defaults are bundled in build_config.py. These **repository variables** may override them after verifying the corresponding service:

| Variable | Purpose |
|---|---|
| XOTIRA_STATS_URL | HTTPS Worker origin |
| XOTIRA_AUTH_URL | HTTPS Supabase project origin |
| XOTIRA_AUTH_KEY | Supabase publishable API key |
| XOTIRA_AUTH_SITE_URL | https://memory-map-ecru.vercel.app/account-confirmed.html |

For Supabase Auth, require email confirmation and configure production SMTP.
Enable the Google provider with its OAuth credentials and configure the site URL
and allowlisted loopback callback
`http://127.0.0.1:*/account/callback**`. The app uses a random, expiring
one-time nonce and PKCE. Account passwords never travel through the analytics service. The owner’s short-lived
access token is sent only to the official Worker when requesting owner statistics;
it is verified against Supabase and is never stored. Verified Google sign-in is mandatory before vault creation or unlock. Vault locking keeps the current in-memory account session; sign-out and session expiry lock the vault. Tokens are not persisted. Google sign-in does not synchronize notes.

## Owner statistics

Apply the migration in `supabase/migrations`. Add the exact owner mailbox to
`memory_map_private.owner_accounts` directly in the private project (do not
commit real email addresses). Configure the Worker with the public Auth URL
and publishable key as `AUTH_URL` and `AUTH_KEY`. Only a confirmed account
with a current server-side session and a matching owner entry can read account
counts or anonymized usage. Anonymous statistics are off until users opt in.
In the app, open File → Account, sign in and choose Owner statistics. The app
labels missing usage data as unavailable rather than inventing zeros.

## Release workflow

CI builds Windows x64, macOS Apple Silicon and Intel, and Linux x64 and ARM64.
The Android job packages the same local Python core, verifies Java crypto
compatibility and starts the bundled service in an emulator. The Android release
uses a stable private signing key stored as GitHub Actions secrets. The running
workspace opens in an Android-native window, while external OAuth uses the system browser.
macOS uses a standard windowed one-directory app bundle, including its native frameworks. Packaging seals the completed bundle, verifies the resource signature after mounting the disk image, and opens a copied app through LaunchServices with an isolated test vault. For normal Gatekeeper approval, configure Apple Developer ID and notarization credentials; an ad-hoc resource seal tests integrity but does not establish publisher trust.

Each desktop build runs existing tests and a standalone smoke test. The release
job groups verified distributives with SHA256SUMS.txt and creates a draft for
a new version on main or a matching version tag. Existing releases are never
replaced; increment the version for subsequent release candidates. Before
publishing, verify all jobs and the signing status, public site, statistics
endpoint and real account registration. Only then publish the draft. iOS/iPadOS
requires a separate tested native build and Apple signing/distribution.

Desktop auto-update is optional. The app checks the configured GitHub
repository, matches its desktop platform and architecture, verifies the official
asset digest and stages the executable in private app storage. When both the
preference and a newer verified executable are present, the launcher opens it on
a subsequent launch. A disabled preference prevents automatic downloads and
launches. Android installations update through the platform's signed APK
installation mechanism.

## Private material

Do not publish local vaults, user backups, .env files, provider secrets, signing
keys, runtime state, credentials, or private QA artifacts. Release archives
contain application files and public configuration only. Test data is synthetic.
