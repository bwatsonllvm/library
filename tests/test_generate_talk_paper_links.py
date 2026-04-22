import importlib.util
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = REPO_ROOT / "scripts" / "generate-talk-paper-links.py"


def load_module():
    spec = importlib.util.spec_from_file_location("generate_talk_paper_links", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class GenerateTalkPaperLinksTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = load_module()

    def test_normalize_github_url_fixes_known_pdf_joined_repo_name(self):
        self.assertEqual(
            self.module.normalize_github_url("github.com/ssrg-vt/ELLFSource"),
            "https://github.com/ssrg-vt/ELLF",
        )

    def test_extract_reference_items_from_text_uses_corrected_repo_url(self):
        refs = self.module.extract_reference_items_from_text(
            (
                "There seems to be no reliable way to stop clang from merging them. "
                "github.com/ssrg-vt/ELLFSource code of ELLF."
            ),
            source="slides",
        )
        self.assertEqual(
            [ref["url"] for ref in refs],
            ["https://github.com/ssrg-vt/ELLF"],
        )
        self.assertEqual(
            refs[0]["repository"],
            "ssrg-vt/ELLF",
        )


if __name__ == "__main__":
    unittest.main()
