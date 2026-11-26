"""Tests for Xotira v25 global features: DOCX/EPUB export, BibTeX parser, semantic & PDF/DOCX search."""

from __future__ import annotations

import io
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile

from academic_export import export_note_docx, export_note_epub, parse_bibtex_to_note
from agent_api import search_brain, semantic_search_brain
from vault import Vault


class V25GlobalFeaturesTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.vault = Vault(Path(self.tmp.name) / "v25.xotira")
        self.vault.unlock("v25-global-strong-pass!", create=True)

    def tearDown(self) -> None:
        self.vault.lock()
        self.tmp.cleanup()

    def test_docx_and_epub_export(self) -> None:
        [note_id] = self.vault.create_notes([{
            "title": "Global Research Draft",
            "tags": ["Writing", "Research"],
            "body": "# Intro\n\n- Key bullet point\n- [x] Finished task\n\n```python\nprint('hello')\n```\n",
        }])
        note = self.vault.notes[note_id]

        docx_bytes = export_note_docx(note)
        with ZipFile(io.BytesIO(docx_bytes)) as zf:
            self.assertEqual(set(zf.namelist()), {"[Content_Types].xml", "_rels/.rels", "word/document.xml"})
            xml = zf.read("word/document.xml").decode("utf-8")
            self.assertIn("Global Research Draft", xml)
            self.assertIn("Key bullet point", xml)

        epub_bytes = export_note_epub(note)
        with ZipFile(io.BytesIO(epub_bytes)) as zf:
            names = zf.namelist()
            self.assertEqual(names[0], "mimetype")
            self.assertEqual(zf.read("mimetype"), b"application/epub+zip")
            self.assertIn("OEBPS/content.opf", names)
            chap = zf.read("OEBPS/chapter.xhtml").decode("utf-8")
            self.assertIn("Global Research Draft", chap)
            self.assertIn("Key bullet point", chap)

    def test_bibtex_parser_creates_structured_paper_note(self) -> None:
        bibtex = """@inproceedings{vaswani2017attention,
          title={Attention Is All You Need},
          author={Vaswani, Ashish and Shazeer, Noam},
          booktitle={NeurIPS},
          year={2017},
          doi={10.48550/arXiv.1706.03762}
        }"""
        draft = parse_bibtex_to_note(bibtex)
        self.assertEqual(draft["title"], "Attention Is All You Need")
        self.assertIn("Paper", draft["tags"])
        self.assertIn("2017", draft["tags"])
        self.assertIn("https://doi.org/10.48550/arXiv.1706.03762", draft["body"])
        self.assertIn("[^1]:", draft["body"])

        [note_id] = self.vault.create_notes([draft])
        self.assertEqual(self.vault.notes[note_id].title, "Attention Is All You Need")

    def test_local_semantic_search_and_attachment_content_search(self) -> None:
        [nid] = self.vault.create_notes([
            {"title": "Quarterly Tax Planning", "body": "Deductions, invoices, and fiscal compliance checklist.", "tags": ["Finance"]},
        ])
        # Attach a DOCX and a simple PDF with text operator
        docx_bytes = export_note_docx(self.vault.notes[nid])
        self.vault.store_attachment(nid, "compliance.docx", docx_bytes)
        fake_pdf = b"%PDF-1.4\n1 0 obj << /Length 44 >> stream\nBT (Quantum cryptography protocol) Tj ET\nendstream\nendobj\n%%EOF"
        self.vault.store_attachment(nid, "paper.pdf", fake_pdf)

        # Attachment full-text search finds PDF text
        pdf_hit = search_brain(self.vault, "cryptography")
        self.assertTrue(any(f["name"] == "paper.pdf" for f in pdf_hit["files"]))

        # Local semantic similarity search handles morphological/fuzzy overlap ("deducting invoiced")
        sem = semantic_search_brain(self.vault, "deducting invoiced")
        self.assertEqual(sem["mode"], "semantic")
        self.assertTrue(any(r["id"] == nid for r in sem["results"]))


if __name__ == "__main__":
    unittest.main()
