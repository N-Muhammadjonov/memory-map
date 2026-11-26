import base64
import hashlib
import io
import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
PASSWORD = "sinov uchun alohida parol 528"
SECRET_TEXT = "Maxfiy sinov: Xotirada saqlanadi."
SECRET_FILE = b"Unique attachment content for tests."


class LocalApp:
    def __init__(self, vault: Path, backup_dir: Path | None = None) -> None:
        command = [sys.executable, str(ROOT / "app.py"), "--no-browser", "--vault", str(vault)]
        if backup_dir:
            command.extend(["--backup-dir", str(backup_dir)])
        self.command = command

    def __enter__(self):
        self.process = subprocess.Popen(self.command, stdout=subprocess.PIPE, text=True)
        launch = self.process.stdout.readline().strip()
        if "http://127.0.0.1:" not in launch:
            self.process.stdout.close()
            self.process.wait(timeout=5)
            raise RuntimeError("Xotira did not start")
        self.origin, self.token = launch[launch.index("http://"):].strip().split("/#")
        return self

    def __exit__(self, *exc) -> None:
        self.process.terminate()
        self.process.wait(timeout=5)
        self.process.stdout.close()

    def call(self, path: str, body: dict | None = None, *, auth: bool = True, raw: bool = False):
        headers = {"Authorization": f"Bearer {self.token}"} if auth else {}
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers.update({"Origin": self.origin, "Content-Type": "application/json"})
        request = Request(self.origin + path, data, headers)
        with urlopen(request, timeout=10) as response:
            return response.read() if raw else json.load(response)

    def upload(self, note_id: str, name: str, data: bytes, *, auth: bool = True) -> dict:
        path = self.origin + f"/api/notes/{note_id}/files?" + urlencode({"name": name})
        headers = {"Content-Type": "application/octet-stream", "Origin": self.origin}
        if auth:
            headers["Authorization"] = f"Bearer {self.token}"
        with urlopen(Request(path, data, headers), timeout=10) as response:
            self.assert_created(response.status)
            return json.load(response)

    def import_folder(self, source: str, files: dict[str, bytes], *, auth: bool = True) -> dict:
        index = json.dumps({"source": source, "files": [[path, len(data)] for path, data in files.items()]}).encode()
        packet = len(index).to_bytes(4, "big") + index + b"".join(files.values())
        headers = {"Content-Type": "application/octet-stream", "Origin": self.origin}
        if auth:
            headers["Authorization"] = f"Bearer {self.token}"
        request = Request(self.origin + "/api/import/folder", packet, headers)
        with urlopen(request, timeout=10) as response:
            self.assert_created(response.status)
            return json.load(response)

    @staticmethod
    def assert_created(status: int) -> None:
        if status != 201:
            raise AssertionError(f"Expected HTTP 201, received {status}")


class VaultLifecycleTest(unittest.TestCase):
    def test_create_edit_secure_backup_restore(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            vault = root / "main.xotira"
            backup = root / "restored.xotira"
            auto_backup = root / "auto"
            auto_backup.mkdir()
            with LocalApp(vault, auto_backup) as app:
                self.assertEqual(app.call("/api/status")["exists"], False)
                self.assert_http_error(401, lambda: app.call("/api/status", auth=False))
                self.assert_http_error(423, lambda: app.call("/api/graph"))
                app.call("/api/create", {"password": PASSWORD})
                first, second = app.call("/api/notes", {"notes": [
                    {"title": "Asos", "tags": ["Ilm"], "body": SECRET_TEXT + "\n[[Mavzu]]"},
                    {"title": "Mavzu", "body": "Mavzu matni."},
                ]})["ids"]
                self.assertEqual(app.call("/api/graph")["edges"], [[first, second]])
                self.assertEqual(app.call("/api/graph?q=Maxfiy")["hits"], [first])
                valid = {"revision": 1, "title": "Yangi mavzu", "body": "Tahrir", "tags": ["Reja"]}
                app.call(f"/api/notes/{second}", valid)
                self.assert_http_error(409, lambda: app.call(f"/api/notes/{second}", valid))
                self.assertEqual(app.call("/api/graph")["edges"], [[first, second]])
                with self.assertRaises(HTTPError):
                    app.call("/api/notes", {"notes": [{"title": "Uchinchi"}, {"title": "Mavzu"}]})
                self.assertEqual(len(app.call("/api/graph")["nodes"]), 2)

                import base64
                file = app.call(f"/api/notes/{first}/files", {
                    "name": "Maxfiy fayl.txt", "data": base64.b64encode(SECRET_FILE).decode(),
                })
                self.assertEqual(app.call(f"/api/notes/{first}/files/{file['id']}", raw=True), SECRET_FILE)
                with zipfile.ZipFile(io.BytesIO(app.call("/api/export", raw=True))) as exported:
                    self.assertIn(b"[[Yangi mavzu]]", exported.read("Asos.md"))
                    attachment = next(name for name in exported.namelist() if name.startswith("assets/"))
                    self.assertEqual(exported.read(attachment), SECRET_FILE)
                app.call(f"/api/notes/{second}", {"revision": 2, "trashed": True})
                self.assertEqual(app.call("/api/graph")["edges"], [[first, file["id"]]])
                self.assertEqual(app.call("/api/graph?trash=1")["nodes"][0]["id"], second)
                app.call(f"/api/notes/{second}", {"revision": 3, "trashed": False})
                backup.write_bytes(app.call("/api/backup", raw=True))
                self.assertTrue(list(auto_backup.glob("*.xotira")))
                for path in (vault, backup, *auto_backup.glob("*.xotira")):
                    ciphertext = path.read_bytes()
                    for clear in (PASSWORD.encode(), SECRET_TEXT.encode(), SECRET_FILE, b"Maxfiy fayl.txt"):
                        self.assertNotIn(clear, ciphertext)
                app.call("/api/lock", {})
                self.assert_http_error(423, lambda: app.call("/api/graph"))
            with LocalApp(backup) as restored:
                self.assertTrue(restored.call("/api/status")["exists"])
                restored.call("/api/unlock", {"password": PASSWORD})
                self.assertIn(SECRET_TEXT, restored.call(f"/api/notes/{first}")["body"])
                self.assertEqual(restored.call(f"/api/notes/{first}/files/{file['id']}", raw=True), SECRET_FILE)
                self.assertEqual({tuple(edge) for edge in restored.call("/api/graph")["edges"]},
                                 {(first, second), (first, file["id"])})
            with LocalApp(vault) as reopened:
                self.assert_http_error(403, lambda: reopened.call("/api/unlock", {"password": "wrong"}))
                self.assert_http_error(429, lambda: reopened.call("/api/unlock", {"password": PASSWORD}))

    def test_upload_large_file_and_view_office_from_encrypted_vault(self) -> None:
        with tempfile.TemporaryDirectory() as directory, LocalApp(Path(directory) / "files.xotira") as app:
            app.call("/api/create", {"password": PASSWORD})
            [note_id] = app.call("/api/notes", {"notes": [{"title": "Materiallar"}]})["ids"]
            large_file = bytes(13 * 1024 * 1024)
            name = "Dars & qayd #1.bin"
            self.assert_http_error(401, lambda: app.upload(note_id, name, b"", auth=False))
            large = app.upload(note_id, name, large_file)
            self.assertEqual(large["name"], name)
            self.assertEqual(app.call(f"/api/notes/{note_id}/files/{large['id']}", raw=True), large_file)

            document = io.BytesIO()
            with zipfile.ZipFile(document, "w") as archive:
                archive.writestr("word/document.xml",
                                 '<word:document xmlns:word="test"><word:body><word:p><word:r>'
                                 '<word:t>Yozuv Markdown emas.</word:t></word:r></word:p>'
                                 '</word:body></word:document>')
            file = app.upload(note_id, "Dars.docx", document.getvalue())
            path = f"/api/notes/{note_id}/files/{file['id']}?view=document"
            self.assertEqual(app.call(path)["sections"], [{"text": "Yozuv Markdown emas."}])
            self.assertEqual(app.call("/api/files")["files"][0]["noteTitle"], "Materiallar")
            app.call("/api/lock", {})
            self.assert_http_error(423, lambda: app.call(path))
            self.assert_http_error(423, lambda: app.call("/api/files"))

    def test_folder_import_resolves_deep_links_attachments_and_rolls_back(self) -> None:
        folder = {
            "Study/Index.md": b"# Index\n[[Plan#Today|Study plan]]\n[[Work/Plan.md]]\n"
                              b"\n| Plan |\n| --- |\n| [[Work/Plan.md\\|Work plan]] |\n\n"
                              b"[English](../Work/English%20Notes.md#intro)\n"
                              b"![[assets/figure.png|240]]\n[Sound](../assets/audio.mp3)\n"
                              b"`[[Missing]]`",
            "Study/Plan.md": b"# Today\n[[../Work/Plan]]",
            "Work/Plan.md": b"Work",
            "Work/English Notes.md": b"# Intro",
            "Study/assets/figure.png": SECRET_FILE,
            "assets/audio.mp3": b"Audio data",
        }
        with tempfile.TemporaryDirectory() as directory:
            vault = Path(directory) / "folder.xotira"
            with LocalApp(vault) as app:
                self.assert_http_error(401, lambda: app.import_folder("Vault", folder, auth=False))
                self.assert_http_error(423, lambda: app.import_folder("Vault", folder))
                app.call("/api/create", {"password": PASSWORD})
                self.assert_http_error(400, lambda: app.import_folder("Broken", {"Good.md": b"data", "Invalid.md": b"\xff"}))
                self.assert_http_error(400, lambda: app.import_folder("Broken", {"../Outside.md": b"data"}))
                self.assertEqual(app.call("/api/graph")["nodes"], [])
                self.assertEqual(app.import_folder("Vault", folder), {"notes": 4, "files": 2, "existing": 0})
                data = app.call("/api/graph")
                notes = {note["path"]: note["id"] for note in data["nodes"]}
                files = {file["path"]: file for file in data["files"]}
                source = notes["Study/Index.md"]
                self.assertEqual({tuple(edge) for edge in data["edges"]}, {
                    (source, notes["Study/Plan.md"]), (source, notes["Work/Plan.md"]),
                    (source, notes["Work/English Notes.md"]),
                    (source, files["Study/assets/figure.png"]["id"]), (source, files["assets/audio.mp3"]["id"]),
                    (notes["Study/Plan.md"], notes["Work/Plan.md"]),
                })
                note = app.call(f"/api/notes/{source}")
                self.assertEqual(note["links"]["wiki:Plan"], notes["Study/Plan.md"])
                self.assertEqual(note["links"]["md:../Work/English%20Notes.md#intro"], notes["Work/English Notes.md"])
                self.assertEqual(len(note["attachments"]), 2)
                image = files["Study/assets/figure.png"]
                self.assertEqual(app.call(f"/api/notes/{image['noteId']}/files/{image['id']}", raw=True), SECRET_FILE)
                self.assertEqual(app.import_folder("Vault", folder), {"notes": 0, "files": 0, "existing": 6})
                with zipfile.ZipFile(io.BytesIO(app.call("/api/export", raw=True))) as archive:
                    self.assertEqual(archive.read("Vault/Study/Index.md"), folder["Study/Index.md"])
                    self.assertEqual(archive.read("Vault/Study/assets/figure.png"), SECRET_FILE)
                self.assertNotIn(b"Study/Index.md", vault.read_bytes())
                self.assertNotIn(SECRET_FILE, vault.read_bytes())
            with LocalApp(vault) as reopened:
                reopened.call("/api/unlock", {"password": PASSWORD})
                self.assertEqual(len(reopened.call("/api/graph")["nodes"]), 4)
                self.assertEqual(len(reopened.call("/api/graph")["edges"]), 6)

    def assert_http_error(self, code, request) -> None:
        with self.assertRaises(HTTPError) as failure:
            request()
        self.assertEqual(failure.exception.code, code)

    def test_drawing_atomic_lifecycle_and_legacy_png(self) -> None:
        png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jO9sAAAAASUVORK5CYII=")
        image = base64.b64encode(png).decode("ascii")
        strokes = [{"color": "#183455", "size": 4, "points": [[12, 23], [45, 80]]}]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "draw.xotira"
            with LocalApp(path) as app:
                app.call("/api/create", {"password": PASSWORD})
                [note] = app.call("/api/notes", {"notes": [{"title": "Chizmalar", "body": "O‘ng tomon 🌿\nIkkinchi qator"}]})["ids"]
                create = f"/api/notes/{note}/files?view=drawing"
                payload = {"image": image, "strokes": strokes, "offset": 12, "revision": 1}
                self.assert_http_error(400, lambda: app.call(create, {**payload, "offset": 400}))
                self.assertEqual(app.call("/api/files")["files"], [])
                created = app.call(create, payload)
                attachment = created["id"]
                url = f"/api/notes/{note}/files/{attachment}?view=drawing"
                self.assertIn(f"![Chizma](attachment:{attachment})", created["note"]["body"])
                self.assertEqual(app.call(url), {"revision": 1, "strokes": strokes, "base": ""})
                with zipfile.ZipFile(io.BytesIO(app.call("/api/export", raw=True))) as exported:
                    picture = next(name for name in exported.namelist() if name.startswith(f"assets/{attachment}/"))
                    self.assertIn(f"![Chizma]({picture})".encode(), exported.read("Chizmalar.md"))
                    self.assertEqual(exported.read(picture), png)
                self.assert_http_error(409, lambda: app.call(create, payload))
                edited = {"image": image, "strokes": [], "revision": 1, "keepBase": False}
                self.assertEqual(app.call(url, edited), {"revision": 2})
                self.assert_http_error(409, lambda: app.call(url, edited))
                self.assertNotIn(b"#183455", path.read_bytes())
                legacy = app.upload(note, "Chizma-2026-11-21T03-58-28.png", png)
                legacy_url = f"/api/notes/{note}/files/{legacy['id']}?view=drawing"
                self.assertEqual(app.call(legacy_url), {"revision": 0, "strokes": [], "base": image})
                app.call(legacy_url, {**edited, "revision": 0, "strokes": strokes, "keepBase": True})
                self.assertEqual(app.call(legacy_url), {"revision": 1, "strokes": strokes, "base": image})
                ordinary = app.upload(note, "Tahrir.png", png)
                normal_url = f"/api/notes/{note}/files/{ordinary['id']}?view=drawing"
                self.assert_http_error(415, lambda: app.call(normal_url, {"delete": True, "revision": 2}))
                self.assert_http_error(409, lambda: app.call(url, {"delete": True, "revision": 1}))
                updated_note = app.call(url, {"delete": True, "revision": 2})
                self.assertNotIn(attachment, updated_note["body"])
                self.assert_http_error(404, lambda: app.call(url))
            with LocalApp(path) as app:
                app.call("/api/unlock", {"password": PASSWORD})
                self.assertEqual(app.call(legacy_url)["base"], image)
                self.assertEqual(app.call(legacy_url)["strokes"], strokes)
                self.assertNotIn(attachment, app.call(f"/api/notes/{note}")["body"])

    def test_canvas_graph_positions_and_permanent_trash(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "vault.xotira"
            with LocalApp(path) as app:
                app.call("/api/create", {"password": PASSWORD})
                keep, first, second = app.call("/api/notes", {"notes": [
                    {"title": "Saqlanadigan qayd"}, {"title": "Savat 1"}, {"title": "Savat 2"},
                ]})["ids"]
                board = {"nodes": [{"id": "n", "type": "text", "text": "Canvas sir matni",
                                    "x": 30, "y": 20, "width": 200, "height": 100}], "edges": []}
                original = json.dumps(board).encode()
                canvas = app.upload(keep, "Reja.canvas", original)["id"]
                attachment = app.upload(first, "Qayd.txt", SECRET_FILE)["id"]
                canvas_url = f"/api/notes/{keep}/files/{canvas}"
                board["nodes"][0]["x"] = 150
                payload = {"checksum": hashlib.sha256(original).hexdigest(), "canvas": board}
                result = app.call(canvas_url, payload)
                saved = app.call(canvas_url, raw=True)
                self.assertEqual(json.loads(saved), board)
                self.assertEqual(result["checksum"], hashlib.sha256(saved).hexdigest())
                self.assert_http_error(409, lambda: app.call(canvas_url, payload))
                self.assert_http_error(415, lambda: app.call(f"/api/notes/{first}/files/{attachment}", payload))
                moved = {canvas: [12.5, -7.25, 1], attachment: [-10, 4, 5], first: [1, 2, 3]}
                for item_id, position in moved.items():
                    app.call("/api/graph/position", {"id": item_id, "position": position})
                self.assert_http_error(400, lambda: app.call("/api/graph/position", {"id": keep, "position": [400, 0, 0]}))
                self.assert_http_trash_conflict(app, first, 1)
                for note_id in (first, second):
                    app.call(f"/api/notes/{note_id}", {"revision": 1, "trashed": True})
                self.assert_http_trash_conflict(app, first, 1)
                self.assertEqual(app.call("/api/trash", {"action": "delete", "note": {"id": first, "revision": 2}})["ids"], [first])
                self.assertEqual(app.call("/api/trash", {"action": "empty"})["ids"], [second])
                self.assertEqual(app.call("/api/graph?trash=1")["nodes"], [])
                self.assert_http_error(404, lambda: app.call(f"/api/notes/{first}/files/{attachment}", raw=True))
                self.assertNotIn(b"Canvas sir matni", path.read_bytes())
            with LocalApp(path) as app:
                app.call("/api/unlock", {"password": PASSWORD})
                graph = app.call("/api/graph")
                self.assertEqual([note["id"] for note in graph["nodes"]], [keep])
                self.assertEqual(graph["positions"], {canvas: moved[canvas]})
                self.assertEqual(json.loads(app.call(canvas_url, raw=True)), board)

    def assert_http_trash_conflict(self, app: LocalApp, note_id: str, revision: int) -> None:
        self.assert_http_error(409, lambda: app.call("/api/trash", {"action": "delete",
                                                                  "note": {"id": note_id, "revision": revision}}))


if __name__ == "__main__":
    unittest.main()
