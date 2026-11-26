# Memory map distribution

The installed application keeps an encrypted vault on the user's device. Desktop
install bundles run their own loopback service and open the existing workspace
without requiring a user to install Python. Android embeds the same Python
workspace with an Android-native cryptographic backend and a foreground
service.

| Platform | Release asset |
|---|---|
| Windows x64 | MemoryMap-windows-x64.exe |
| macOS Apple Silicon | MemoryMap-macos-arm64.zip (application bundle) |
| macOS Intel | MemoryMap-macos-x64.zip (application bundle) |
| Linux x64 | MemoryMap-linux-x64.tar.gz |
| Linux ARM64 | MemoryMap-linux-arm64.tar.gz |
| Android ARM64 and x86_64 (Android 7.0+) | MemoryMap-android.apk |
| iOS / iPadOS | A separate native port and Apple distribution are required |

The GitHub Actions workflow builds and tests the desktop binaries on the
matching platform. Android must pass its cryptography known-answer checks and
emulator vault checks. Only the verified public release is advertised on the
[download website](https://memory-map-ecru.vercel.app/).

Desktop users may turn on verified automatic updates. The app matches the
platform and architecture, verifies the official GitHub asset digest, and
stages a newer executable for a subsequent launch. Android updates use APKs
with the same application ID and signing identity and the system's approval
flow. See [PUBLIC_RELEASE.md](PUBLIC_RELEASE.md) for the rollout checklist.

Apple Developer ID signing/notarization and Windows publisher signing may
require separate certificates. Signing status is reported on the release.
