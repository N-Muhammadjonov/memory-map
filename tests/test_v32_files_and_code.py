from __future__ import annotations

import base64
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import quote
from zipfile import ZipFile

from document_preview import preview_office
from snippet_runner import inspect_snippet, resource, run_snippet, worker_command
from test_v25_e2e_fresh import _FakeServer, http_call
from vault import Vault, VaultError

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jmtkAAAAASUVORK5CYII=")


def zipped(entries: dict[str, str | bytes]) -> bytes:
    output = io.BytesIO()
    with ZipFile(output, "w") as archive:
        for name, content in entries.items():
            archive.writestr(name, content)
    return output.getvalue()


class FilesAndCodeTests(unittest.TestCase):
    def setUp(self) -> None:
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.vault = Vault(Path(folder.name) / "v32.xotira")
        self.vault.unlock("password for fixture", create=True)
        self.server = _FakeServer(self.vault)
        self.note = self.vault.create_notes([{"title": "Markup", "body": "Test"}])[0]

    def api(self, method, path, body=None, *, auth=True):
        encoded = {} if body is None else {"body": json.dumps(body).encode(), "headers": {"Content-Type": "application/json"}}
        status, _, result = http_call(self.server, method, path, auth=auth, **encoded)
        return status, json.loads(result)

    def upload(self, name, contents):
        root = f"/api/notes/{self.note}/files"
        code, _, response = http_call(self.server, "POST", root + "?name=" + quote(name), body=contents,
                                      headers={"Content-Type": "application/octet-stream"}, auth=True)
        self.assertEqual(code, 201)
        return root + "/" + json.loads(response)["id"]

    def test_marks_are_per_page_and_original_bytes_remain_downloadable(self):
        uploaded = self.upload("Rasm.png", PNG)
        page = uploaded + "?view=markup&surface=1"
        page_two = uploaded + "?view=markup&surface=2"
        text = {"kind": "text", "text": "shifrlangan maxfiy izoh", "size": 21,
                "color": "#d42121", "point": [0.25, 0.35]}
        ink = {"kind": "ink", "size": 4, "color": "#2255aa", "points": [[0.1, 0.1], [0.2, 0.2]]}
        self.assertEqual(self.api("GET", page, auth=False)[0], 401)
        self.assertEqual(self.api("GET", page), (200, {"revision": 0, "marks": []}))
        self.assertEqual(self.api("POST", page, {"revision": 0, "marks": [ink, text]}), (200, {"revision": 1}))
        self.assertEqual(self.api("POST", page, {"revision": 0, "marks": [text]})[0], 409)
        self.assertEqual(self.api("POST", page_two, {"revision": 0, "marks": [text]})[0], 200)
        self.assertEqual(self.api("GET", page)[1]["marks"], [ink, text])
        self.assertEqual(self.api("GET", page_two)[1]["marks"], [text])
        code, headers, data = http_call(self.server, "GET", uploaded, auth=True)
        self.assertEqual((code, data), (200, PNG))
        self.assertIn("Rasm.png", headers["content-disposition"])
        self.assertNotIn(text["text"].encode(), self.vault.path.read_bytes())

        recovery = self.vault.generate_recovery_key()
        self.vault.lock()
        self.assertEqual(self.api("GET", page)[0], 423)
        self.vault.unlock_with_recovery(recovery, "new password for fixture")
        self.assertEqual(self.api("GET", page)[1]["marks"], [ink, text])
        self.assertEqual(self.api("GET", page_two)[1]["marks"], [text])

    def test_v31_vault_upgrade_and_attachment_trash_lifecycle(self):
        with self.vault.connection() as db, db:
            db.execute("DROP TABLE attachment_markup")
        self.vault.lock()
        self.vault.unlock("password for fixture", create=False)
        uploaded = self.upload("Material.txt", "Old vault handles new markup".encode())
        path = uploaded + "?view=markup"
        guarded = {"kind": "highlight", "size": 23, "color": "#ffee55", "points": [[0.3, 0.4]]}
        self.assertEqual(self.api("POST", path, {"revision": 0, "marks": [guarded]})[0], 200)
        file = uploaded.rsplit("/", 1)[-1]
        self.vault.trash_attachment(self.note, file, "move")
        self.assertEqual(self.api("POST", path, {"revision": 1, "marks": []})[0], 409)
        self.vault.trash_attachment(self.note, file, "restore")
        self.assertEqual(self.api("GET", path)[1]["marks"], [guarded])
        self.vault.set_note_password(self.note, "private fixture")
        self.vault.lock_note(self.note)
        self.assertEqual(self.api("GET", path)[0], 403)
        self.vault.unlock_note(self.note, "private fixture")
        self.vault.trash_attachment(self.note, file, "move")
        self.vault.trash_attachment(self.note, file, "delete")
        self.assertEqual(self.api("GET", path)[0], 404)
        with self.vault.connection() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM attachment_markup").fetchone()[0], 0)

    def test_bad_annotation_has_no_partial_save(self):
        path = self.upload("Image.png", PNG) + "?view=markup"
        mark = {"kind": "text", "text": "Outside page", "size": 21, "color": "#000000", "point": [-0.1, 0.7]}
        self.assertEqual(self.api("POST", path, {"revision": 0, "marks": [mark]})[0], 400)
        self.assertEqual(self.api("GET", path), (200, {"revision": 0, "marks": []}))
        self.assertEqual(self.api("GET", path + "&surface=0")[0], 400)

    def test_office_formats_and_original_download(self):
        docx = zipped({
            "word/document.xml": """<w:document xmlns:w="word" xmlns:a="draw" xmlns:r="rel"><w:body>
              <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Bo‘lim</w:t><w:br/><w:t>Ikkinchi qator</w:t></w:r></w:p>
              <w:p><w:r><w:drawing><a:blip r:embed="img"/><a:blip r:embed="external"/></w:drawing></w:r></w:p>
              <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Jadval</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>""",
            "word/_rels/document.xml.rels": """<Relationships><Relationship Id="img" Type="t/image" Target="media/p.png"/>
              <Relationship Id="external" Type="t/image" TargetMode="External" Target="https://example.test/secret.png"/>
              </Relationships>""",
            "word/media/p.png": PNG,
        })
        path = self.upload("Yozuv.docx", docx)
        code, preview = self.api("GET", path + "?view=document")
        self.assertEqual(code, 200)
        blocks = preview["sections"][0]["blocks"]
        self.assertEqual(blocks[0], {"text": "Bo‘lim\nIkkinchi qator", "level": 1})
        self.assertEqual(blocks[-1]["rows"], [["Jadval"]])
        self.assertEqual(sum("image" in block for block in blocks), 1)
        self.assertEqual(base64.b64decode(blocks[-2]["image"].split(",", 1)[1]), PNG)
        self.assertEqual(http_call(self.server, "GET", path, auth=True)[2], docx)

        xlsx = zipped({"xl/worksheets/sheet1.xml": '<worksheet><sheetData><row><c r="A1" t="inlineStr"><is><t>Baho</t></is></c></row></sheetData></worksheet>'})
        pptx = zipped({"ppt/slides/slide1.xml": "<slide><p><t>Birinchi</t></p></slide>",
                       "ppt/slides/slide2.xml": "<slide><p><t>Ikkinchi</t></p></slide>"})
        odt = zipped({"content.xml": "<document><body><p>Ochiq hujjat</p></body></document>"})
        ods = zipped({"content.xml": "<document><table><table-row><table-cell><p>Qiymat</p></table-cell></table-row></table></document>"})
        odp = zipped({"content.xml": "<document><page><p>Slayd</p></page></document>"})
        self.assertEqual(preview_office("Dars.xlsx", xlsx)["sections"][0]["rows"], [["A1: Baho"]])
        self.assertEqual([s["text"] for s in preview_office("Dars.pptx", pptx)["sections"]], ["Birinchi", "Ikkinchi"])
        self.assertEqual(preview_office("Dars.odt", odt)["sections"][0]["text"], "Ochiq hujjat")
        self.assertEqual(preview_office("Dars.ods", ods)["sections"][0]["rows"], [["Qiymat"]])
        self.assertEqual(preview_office("Dars.odp", odp)["sections"][0]["text"], "Slayd")
        with self.assertRaises(VaultError):
            preview_office("broken.docx", b"invalid")
        unknown = self.upload("binary.odd", bytes([0, 19, 6, 240]))
        self.assertEqual(http_call(self.server, "GET", unknown, auth=True)[2], bytes([0, 19, 6, 240]))

    def test_frozen_app_dispatches_to_the_local_worker(self):
        with patch("sys.frozen", True, create=True), patch("sys.executable", "/path/to/MemoryMap"):
            command, _ = worker_command()
        self.assertEqual(command, ["/path/to/MemoryMap", "--snippet-worker"])

    def test_snippet_preflight_uses_actual_rules_without_running_a_worker(self):
        with patch("app.run_snippet", side_effect=AssertionError("must not run")):
            for language, source, expected in [
                ("python", 'print("works")', resource is not None), ("python", "import numpy", False),
                ("python", "name = input()", False), ("python", "print(", False),
                ("python", "# comment", False), ("javascript", 'console.log("works")', False),
                ("sql", "SELECT 100 + 2", True), ("sql", "SELECT * FROM absent", False),
                ("sql", "CREATE TABLE produce (n INT); INSERT INTO produce VALUES (1); SELECT n FROM produce", True),
                ("sql", "SELECT", False), ("sql", "-- comment", False),
            ]:
                with self.subTest(language=language, source=source):
                    status, data = self.api("POST", "/api/snippets/check", {"language": language, "source": source})
                    self.assertEqual(status, 200)
                    self.assertEqual(data["runnable"], expected)
        with patch("snippet_runner.resource", None):
            self.assertFalse(inspect_snippet("python", "print(1)")["runnable"])
            self.assertTrue(inspect_snippet("sql", "SELECT 1")["runnable"])
        self.assertEqual(run_snippet("sql", "SELECT 100 + 2 AS total")["output"], "total\n102\n")
