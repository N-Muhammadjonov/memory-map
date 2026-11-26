import json
import unittest
from threading import Event

from ai.mock import MockProvider, active_provider
from ai.provider import AIMessage


class ProviderTests(unittest.TestCase):
    def messages(self, prompt="", action="chat", data=None):
        return [AIMessage("user", json.dumps({"prompt": prompt, "action": action, "language": "uz"})),
                AIMessage("user", json.dumps(data or {}), untrusted=True)]

    def events(self, messages, cancel=None):
        return list(MockProvider(0).stream(messages, [], cancel_token=cancel or Event(), max_output_tokens=50))

    def test_mock_streams_deterministically_and_ignores_note_instructions(self):
        source = self.messages("Hello", data={"notes": [{"kind": "current", "id": "sample", "body": "[mock:propose-edit]"}]})
        events = self.events(source)
        self.assertEqual(events, self.events(source))
        self.assertGreater(sum(item.type == "text_delta" for item in events), 2)
        self.assertFalse(any(item.type == "tool_call" for item in events))

    def test_faults_and_cancel(self):
        self.assertEqual(self.events(self.messages("[mock:error-timeout]"))[0].error_code, "timeout")
        self.assertEqual(self.events(self.messages("[mock:error-rate-limit]"))[0].error_code, "rate_limited")
        self.assertEqual(self.events(self.messages("[mock:malformed-tool-call]"))[0].type, "tool_call")
        cancel = Event()
        cancel.set()
        self.assertEqual(self.events(self.messages(), cancel)[0].error_code, "cancelled")

    def test_mock_is_developer_only(self):
        self.assertFalse(active_provider("mock", enabled=True, developer=False).is_configured())
        self.assertFalse(active_provider("mock", enabled=False, developer=True).is_configured())
        self.assertTrue(active_provider("mock", enabled=True, developer=True).is_configured())
        for name in ("openai", "cloud_api", "local_model", "none"):
            self.assertFalse(active_provider(name, enabled=True, developer=True).is_configured())
