"""v27: statistics are opt-in, counts only, and can never carry note content."""

from __future__ import annotations

import json
import re
import tempfile
import time
import unittest
from pathlib import Path

import telemetry
from telemetry import FEATURES, MILESTONES, PING_KEYS, RETRY_SECONDS, Telemetry
from vault import Vault, VaultError

ENDPOINT = "https://stats.example.com"
SECRETS = ("SECRET-TITLE-9931", "SECRET-BODY-7742", "SECRET-LINK-5513", "secret-tag-1188")


class Clock:
    def __init__(self) -> None:
        self.value = 1_800_000_000.0

    def __call__(self) -> float:
        return self.value


class TelemetryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.vault = Vault(Path(self.tmp.name) / "a.xotira")
        self.vault.unlock("telemetry-test-password!", create=True)
        self.vault.create_notes([{"title": SECRETS[0], "body": f"{SECRETS[1]} [[{SECRETS[2]}]]", "tags": [SECRETS[3]]}])
        self.sent: list[tuple[str, dict]] = []
        self.ok = True
        self.clock = Clock()

        def post(url: str, payload: dict) -> bool:
            self.sent.append((url, payload))
            return self.ok

        self.tel = Telemetry(self.vault, ENDPOINT, platform="linux", post=post, now=self.clock)

    def tearDown(self) -> None:
        self.vault.lock()
        self.tmp.cleanup()

    def settle(self) -> None:
        for _ in range(100):
            if not self.tel._sending or self.tel._result is not None:
                return
            time.sleep(0.02)

    def tick(self) -> None:
        self.tel.tick()
        self.settle()
        self.tel.tick()  # second call records the finished send

    def test_nothing_is_sent_before_consent(self) -> None:
        self.assertIsNone(self.tel.status()["consent"])
        self.tick()
        self.assertEqual(self.sent, [])
        self.tel.set_consent(False)
        self.tick()
        self.assertEqual([url for url, _ in self.sent if url.endswith("/v1/ping")], [])

    def test_payload_has_only_allowed_keys_and_never_content(self) -> None:
        self.tel.set_consent(True)
        self.tel.observe("/api/notes/" + "a" * 32 + "/share", True)
        payload = self.tel.payload()
        self.assertEqual(set(payload), set(PING_KEYS))
        text = json.dumps(payload)
        for secret in SECRETS:
            self.assertNotIn(secret, text)
        self.assertEqual(payload["notes"], "1-9")
        self.assertTrue(payload["linked"])
        self.assertIn("share", payload["features"])
        self.assertRegex(payload["install_id"], r"^[0-9a-f]{32}$")
        self.assertLessEqual(len(text), 600)

    def test_one_ping_per_day_then_next_day(self) -> None:
        self.tel.set_consent(True)
        self.tick()
        pings = [p for url, p in self.sent if url.endswith("/v1/ping")]
        self.assertEqual(len(pings), 1)
        self.tick()
        self.assertEqual(len([1 for url, _ in self.sent if url.endswith("/v1/ping")]), 1)
        self.clock.value += 86400
        self.tick()
        self.assertEqual(len([1 for url, _ in self.sent if url.endswith("/v1/ping")]), 2)

    def test_failed_send_is_retried_after_a_pause(self) -> None:
        self.tel.set_consent(True)
        self.ok = False
        self.tick()
        self.assertEqual(len(self.sent), 1)
        self.tick()
        self.assertEqual(len(self.sent), 1)  # still cooling down
        self.clock.value += RETRY_SECONDS + 1
        self.ok = True
        self.tick()
        self.assertEqual(len(self.sent), 2)

    def test_switching_off_erases_server_side_data(self) -> None:
        self.tel.set_consent(True)
        install = self.tel._state()["installId"]
        self.tel.set_consent(False)
        time.sleep(0.2)
        forgets = [p for url, p in self.sent if url.endswith("/v1/forget")]
        self.assertEqual(forgets, [{"install_id": install}])
        self.assertNotIn("installId", self.tel._state())
        self.tel.set_consent(True)
        self.assertNotEqual(self.tel._state()["installId"], install)

    def test_routes_map_to_coarse_features_and_milestones(self) -> None:
        self.tel.observe("/api/backup", False)
        self.tel.observe("/api/transfer/export", True)
        self.tel.observe("/api/graph", False)
        self.assertEqual(self.tel.features, {"backup", "transfer"})
        self.assertEqual(self.tel.milestones, {"backup_made", "shared_transfer"})

    def test_unknown_features_and_languages_are_ignored(self) -> None:
        self.tel.feature("my diary", "xx")
        self.assertEqual((self.tel.features, self.tel.lang), (set(), "en"))
        self.tel.feature("graph", "uz")
        self.assertEqual((self.tel.features, self.tel.lang), ({"graph"}, "uz"))

    def test_unavailable_without_endpoint(self) -> None:
        tel = Telemetry(self.vault, "")
        self.assertFalse(tel.status()["available"])
        with self.assertRaises(VaultError):
            tel.set_consent(True)
        self.assertEqual(telemetry.valid_endpoint("http://evil.example.com"), "")
        self.assertEqual(telemetry.valid_endpoint("https://x.example.com/path"), "")

    def test_app_is_blocked_until_the_user_agrees(self) -> None:
        self.assertTrue(self.tel.blocked())
        self.tel.set_consent(True)
        self.assertFalse(self.tel.blocked())
        self.tel.set_consent(False)
        self.assertTrue(self.tel.blocked())
        self.assertFalse(Telemetry(self.vault, "").blocked())  # builds without a statistics address are never blocked

    def test_feedback_needs_consent_and_carries_only_the_form(self) -> None:
        with self.assertRaises(VaultError):
            self.tel.send_feedback("bug", "The graph is empty", "")
        self.tel.set_consent(True)
        self.tel.send_feedback("idea", "  Please add dark mode  ", " @me ")
        url, payload = self.sent[-1]
        self.assertTrue(url.endswith("/v1/feedback"))
        self.assertEqual(set(payload), {"v", "install_id", "kind", "message", "contact", "version", "platform", "lang"})
        self.assertEqual((payload["message"], payload["contact"], payload["kind"]), ("Please add dark mode", "@me", "idea"))
        for secret in SECRETS:
            self.assertNotIn(secret, json.dumps(payload))
        for bad in [("rant", "long enough text"), ("bug", "no"), ("bug", "x" * 2001), ("bug", 5)]:
            with self.assertRaises(VaultError):
                self.tel.send_feedback(*bad)
        self.ok = False
        with self.assertRaises(VaultError) as caught:
            self.tel.send_feedback("bug", "this will not be delivered")
        self.assertEqual(caught.exception.status, 502)

    def test_client_and_worker_allow_lists_match(self) -> None:
        source = (Path(__file__).parent.parent / "stats-worker" / "worker.js").read_text()
        for name, python_values in (("FEATURES", FEATURES), ("MILESTONES", MILESTONES)):
            block = re.search(rf"export const {name} = \[(.*?)\];", source, re.S).group(1)
            self.assertEqual(tuple(re.findall(r'"([a-z_]+)"', block)), tuple(python_values), name)


if __name__ == "__main__":
    unittest.main()
