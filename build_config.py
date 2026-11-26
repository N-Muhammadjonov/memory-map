"""Build-time settings. The release workflow bakes in the GitHub repository and optional statistics URL."""

STATS_URL = ""  # e.g. "https://xotira-stats.<you>.workers.dev"; empty = statistics are unavailable
GITHUB_REPO = "N-Muhammadjonov/memory-map"  # e.g. "owner/memory-map"; empty = update check disabled unless XOTIRA_GITHUB_REPO is set

AUTH_URL = ""  # Public Supabase Auth project URL
AUTH_KEY = ""  # Publishable API key, never a service-role key
AUTH_SITE_URL = "https://memory-map-ecru.vercel.app/account-confirmed.html"

# Public builds keep usage statistics optional. Tester-specific builds may enable this explicitly.
REQUIRE_TELEMETRY_CONSENT = False
