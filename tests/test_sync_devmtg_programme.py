import importlib.util
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = REPO_ROOT / "scripts" / "sync-devmtg-from-llvm-www.py"
FIXTURE_PATH = REPO_ROOT / "tests" / "fixtures" / "devmtg" / "programme-2014-snippet.html"


def load_sync_module():
    spec = importlib.util.spec_from_file_location("sync_devmtg", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class SyncDevMtgProgrammeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = load_sync_module()
        cls.fixture_html = FIXTURE_PATH.read_text(encoding="utf-8")

    def test_parse_speakers_keeps_affiliation_commas_and_splits_name_pairs(self):
        speakers = self.module.parse_speakers("Gabor Ballabas (University of Szeged, Hungary)")
        self.assertEqual(
            [(speaker["name"], speaker["affiliation"]) for speaker in speakers],
            [("Gabor Ballabas", "University of Szeged, Hungary")],
        )

        links = self.module.parse_labeled_links(
            '<a href="PDFs/LightningTalks/EuroLLVM\'14%20--%20ASan%20%2B%20Coverage.pdf">[Slides]</a>',
            "2014-04",
        )
        self.assertEqual(
            links,
            [
                {
                    "label": "Slides",
                    "url": "https://llvm.org/devmtg/2014-04/PDFs/LightningTalks/EuroLLVM'14%20--%20ASan%20%2B%20Coverage.pdf",
                }
            ],
        )

        paired = self.module.parse_programme_speaker_cell(
            "Virgile Prevosto and Franck Védrine (CEA LIST)<br/>Bart Jacobs and Gijs van Spauwen (KU Leuven)"
        )
        self.assertEqual(
            [(speaker["name"], speaker["affiliation"]) for speaker in paired],
            [
                ("Virgile Prevosto", "CEA LIST"),
                ("Franck Védrine", "CEA LIST"),
                ("Bart Jacobs", "KU Leuven"),
                ("Gijs van Spauwen", "KU Leuven"),
            ],
        )

    def test_programme_table_parser_handles_mixed_lightning_and_posters(self):
        meeting, talks = self.module.parse_meeting_page(self.fixture_html, "2014-04")
        self.assertEqual(meeting["talkCount"], 6)

        by_title = {talk["title"]: talk for talk in talks}

        lto = by_title["LTO: History and work to be done"]
        self.assertEqual(
            [(speaker["name"], speaker["affiliation"]) for speaker in lto["speakers"]],
            [("Rafael Ávila de Espíndola", "World Wide Studios/Sony Computer Entertainment")],
        )

        buildbot = by_title["LLVM AArch64 buildbot"]
        self.assertEqual(buildbot["category"], "lightning-talk")
        self.assertEqual(buildbot["videoUrl"], "https://www.youtube.com/watch?v=5EfcRTHsy2g")
        self.assertEqual(buildbot["slidesUrl"], "https://llvm.org/devmtg/2014-04/PDFs/LightningTalks/aarch64_buildbot.pdf")
        self.assertEqual(buildbot["posterUrl"], "https://llvm.org/devmtg/2014-04/PDFs/Posters/aarch64_buildbot_poster.pdf")
        self.assertEqual(
            [(speaker["name"], speaker["affiliation"]) for speaker in buildbot["speakers"]],
            [("Gabor Ballabas", "University of Szeged, Hungary")],
        )

        framac = by_title["Clang as a C++ front-end for Frama-C and VeriFast"]
        self.assertEqual(framac["category"], "poster")
        self.assertIsNone(framac["videoUrl"])
        self.assertEqual(framac["slidesUrl"], "https://llvm.org/devmtg/2014-04/PDFs/Posters/FramaC.pdf")
        self.assertEqual(
            [(speaker["name"], speaker["affiliation"]) for speaker in framac["speakers"]],
            [
                ("Virgile Prevosto", "CEA LIST"),
                ("Franck Védrine", "CEA LIST"),
                ("Bart Jacobs", "KU Leuven"),
                ("Gijs van Spauwen", "KU Leuven"),
            ],
        )

        dbill = by_title["DBILL: An Efficient and Retargetable Dynamic Binary Instrumentation Framework using LLVM Backend"]
        self.assertEqual(dbill["category"], "poster")
        self.assertEqual(
            [(speaker["name"], speaker["affiliation"]) for speaker in dbill["speakers"]],
            [("Yi-Hong Lyu", "Institute of Information Science, Academia Sinica")],
        )


if __name__ == "__main__":
    unittest.main()
