# Memory map statistics (Cloudflare Worker + D1)

Shows you how Memory map is used without ever seeing anyone's notes. Users must agree first; they can preview the exact data and switch it off (which also erases what the server holds about them).

## What is stored
Per install and day: a random install id, app version, platform (windows/macos/linux/ios/android/web), interface language, a note-count **range** (0, 1-9, 10-49, 50-199, 200+), whether any two notes are linked, a list of feature names from a fixed list, and milestones from a fixed list. Plus the country code Cloudflare provides. **Never** note text, titles, tags, file names, passwords, e-mail or IP address. The worker rejects any other field (see `worker.test.mjs`).

## Deploy (about 10 minutes)
```
cd stats-worker
npx wrangler d1 create xotira-stats                      # copy database_id into wrangler.toml
npx wrangler d1 execute xotira-stats --remote --file=schema.sql
npx wrangler secret put ADMIN_TOKEN                       # long random string only you know
npx wrangler deploy                                       # prints https://xotira-stats.<you>.workers.dev
```
Then in the GitHub repository: Settings → Variables → `XOTIRA_STATS_URL` = that address. Release builds carry it automatically. For a local build set the environment variable `XOTIRA_STATS_URL` instead.

Open `https://xotira-stats.<you>.workers.dev/admin` and enter the token to see installs, daily/weekly/monthly active, platforms, versions, languages, countries, feature usage, milestones and a simple "came back" rate.

## Try it locally first
`ADMIN_TOKEN=local-dev-admin-token node stats-worker/dev-server.mjs 8788` then start Memory map with `XOTIRA_STATS_URL=http://127.0.0.1:8788` and open http://127.0.0.1:8788/admin. Tests: `node --no-warnings --test stats-worker/worker.test.mjs`.

## Notes
- Cloudflare's free D1 plan is plenty for thousands of installs (one small row per install per day).
- Put your privacy contact and this list of collected fields in your public privacy page before inviting people outside your circle. If you have users in the EU/UK, this opt-in design is what their rules expect; confirm the wording with a lawyer.


## Feedback screenshots

New D1 databases get the screenshot column from `schema.sql`. For an existing database created before screenshot support, apply the migration once before deploying the updated Worker:

```sh
wrangler d1 execute xotira-stats --remote --file=migrations/0001_feedback_screenshot.sql
```

An attachment is sent only when the user selects and previews an image in the feedback form. The dashboard retrieves the image on demand with the admin token. Withdrawing statistics consent removes the feedback row and its attachment.
