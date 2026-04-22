import importlib.util
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = REPO_ROOT / "scripts" / "sync-devmtg-from-llvm-www.py"
FIXTURE_PATH = REPO_ROOT / "tests" / "fixtures" / "devmtg" / "legacy-2011-snippet.html"
EUROLLVM_2012_FIXTURE_PATH = REPO_ROOT / "tests" / "fixtures" / "devmtg" / "legacy-2012-table.html"
USDEVMTG_2013_FIXTURE_PATH = REPO_ROOT / "tests" / "fixtures" / "devmtg" / "legacy-2013-agenda.html"
EUROLLVM_2015_FIXTURE_PATH = REPO_ROOT / "tests" / "fixtures" / "devmtg" / "legacy-2015-table.html"


def load_sync_module():
    spec = importlib.util.spec_from_file_location("sync_devmtg", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class SyncDevMtgLegacyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = load_sync_module()
        cls.fixture_html = FIXTURE_PATH.read_text(encoding="utf-8")
        cls.eurollvm_2012_fixture_html = EUROLLVM_2012_FIXTURE_PATH.read_text(encoding="utf-8")
        cls.usdevmtg_2013_fixture_html = USDEVMTG_2013_FIXTURE_PATH.read_text(encoding="utf-8")
        cls.eurollvm_2015_fixture_html = EUROLLVM_2015_FIXTURE_PATH.read_text(encoding="utf-8")

    def test_legacy_page_parser_merges_schedule_and_abstracts(self):
        meeting, talks = self.module.parse_meeting_page(self.fixture_html, "2011-11")

        self.assertEqual(meeting["talkCount"], 3)
        by_title = {talk["title"]: talk for talk in talks}

        mc = by_title["LLVM MC In Practice"]
        self.assertEqual(
            [(speaker["name"], speaker["affiliation"]) for speaker in mc["speakers"]],
            [("Jim Grosbach", "Apple"), ("Owen Anderson", "Apple")],
        )
        self.assertEqual(
            mc["slidesUrl"],
            "https://llvm.org/devmtg/2011-11/Grosbach_Anderson_LLVMMC.pdf",
        )

        freebsd = by_title["Integrating LLVM into FreeBSD"]
        self.assertEqual(
            [(speaker["name"], speaker["affiliation"]) for speaker in freebsd["speakers"]],
            [("Brooks Davis", "The FreeBSD Project")],
        )

        ptx = by_title["PTX Back-End: GPU Programming With LLVM"]
        self.assertEqual(
            [(speaker["name"], speaker["affiliation"]) for speaker in ptx["speakers"]],
            [("Justin Holewinski", "Ohio State University")],
        )

    def test_merge_meeting_talks_preserves_existing_manual_talk_edits(self):
        meeting, talks = self.module.parse_meeting_page(self.fixture_html, "2011-11")
        existing_payload = {
            "meeting": {
                "slug": "2011-11",
                "name": "2011 US LLVM Developers' Meeting",
                "date": "November 18, 2011",
                "location": "San Jose, CA, USA",
                "canceled": False,
                "talkCount": 3,
            },
            "talks": [
                {
                    "id": "2011-11-001",
                    "meeting": "2011-11",
                    "meetingName": "2011 US LLVM Developers' Meeting",
                    "meetingLocation": "San Jose, CA, USA",
                    "meetingDate": "November 18, 2011",
                    "category": "technical-talk",
                    "title": "Integrating LLVM into FreeBSD",
                    "speakers": [
                        {"name": "Brooks Davis", "affiliation": ""},
                        {"name": "The FreeBSD Project", "affiliation": ""},
                    ],
                    "abstract": "",
                    "videoUrl": "",
                    "videoId": None,
                    "slidesUrl": "",
                    "projectGithub": "",
                    "tags": [],
                },
                {
                    "id": "2011-11-002",
                    "meeting": "2011-11",
                    "meetingName": "2011 US LLVM Developers' Meeting",
                    "meetingLocation": "San Jose, CA, USA",
                    "meetingDate": "November 18, 2011",
                    "category": "technical-talk",
                    "title": "LLVM MC In Practice",
                    "speakers": [
                        {"name": "Jim Grosbach", "affiliation": ""},
                    ],
                    "abstract": "",
                    "videoUrl": "",
                    "videoId": None,
                    "slidesUrl": "",
                    "projectGithub": "",
                    "tags": [],
                },
                {
                    "id": "2011-11-003",
                    "meeting": "2011-11",
                    "meetingName": "2011 US LLVM Developers' Meeting",
                    "meetingLocation": "San Jose, CA, USA",
                    "meetingDate": "November 18, 2011",
                    "category": "technical-talk",
                    "title": "PTX Back-End: GPU Programming With LLVM",
                    "speakers": [
                        {"name": "Just in Holewinski", "affiliation": ""},
                        {"name": "Ohio State", "affiliation": ""},
                    ],
                    "abstract": "",
                    "videoUrl": "",
                    "videoId": None,
                    "slidesUrl": "",
                    "projectGithub": "",
                    "tags": [],
                },
            ],
        }

        merged, changed, _ = self.module.merge_meeting_talks(
            "2011-11",
            meeting,
            talks,
            existing_payload,
        )

        self.assertFalse(changed)
        by_title = {talk["title"]: talk for talk in merged["talks"]}
        self.assertEqual(
            [(speaker["name"], speaker["affiliation"]) for speaker in by_title["LLVM MC In Practice"]["speakers"]],
            [("Jim Grosbach", "")],
        )
        self.assertEqual(
            [(speaker["name"], speaker["affiliation"]) for speaker in by_title["Integrating LLVM into FreeBSD"]["speakers"]],
            [("Brooks Davis", ""), ("The FreeBSD Project", "")],
        )
        self.assertEqual(
            [(speaker["name"], speaker["affiliation"]) for speaker in by_title["PTX Back-End: GPU Programming With LLVM"]["speakers"]],
            [("Just in Holewinski", ""), ("Ohio State", "")],
        )

    def test_legacy_table_parser_handles_author_title_media_rows(self):
        meeting, talks = self.module.parse_meeting_page(self.eurollvm_2012_fixture_html, "2012-04-12")

        self.assertEqual(meeting["talkCount"], 4)
        by_title = {talk["title"]: talk for talk in talks}

        mcjit = by_title["MCJIT"]
        self.assertEqual(
            [(speaker["name"], speaker["affiliation"]) for speaker in mcjit["speakers"]],
            [("Eli Bendersky", "Intel")],
        )
        self.assertEqual(mcjit["videoUrl"], "https://youtu.be/NYd5gKLfg7s")
        self.assertEqual(
            mcjit["slidesUrl"],
            "https://llvm.org/devmtg/2012-04-12/Slides/Eli_Bendersky.pdf",
        )

        opencl = by_title["Improving Performance of OpenCL on CPUs"]
        self.assertEqual(
            [(speaker["name"], speaker["affiliation"]) for speaker in opencl["speakers"]],
            [("Ralf Karrenberg", "Saarland University"), ("Sebastian Hack", "Saarland University")],
        )

        workshop = by_title["What LLVM can do for you"]
        self.assertEqual(workshop["slidesUrl"], "https://llvm.org/devmtg/2012-04-12/Slides/Workshops/David_Chisnall.pdf")
        self.assertIsNone(workshop["videoUrl"])

    def test_merge_meeting_talks_fills_missing_id_gaps_for_new_rows(self):
        meeting, talks = self.module.parse_meeting_page(self.eurollvm_2012_fixture_html, "2012-04-12")
        existing_payload = {
            "meeting": {
                "slug": "2012-04-12",
                "name": "2012 EuroLLVM Developers' Meeting",
                "date": "April 12, 2012",
                "location": "London, UK",
                "canceled": False,
                "talkCount": 3,
            },
            "talks": [
                {
                    "id": "2012-04-12-001",
                    "meeting": "2012-04-12",
                    "meetingName": "2012 EuroLLVM Developers' Meeting",
                    "meetingLocation": "London, UK",
                    "meetingDate": "April 12, 2012",
                    "category": "technical-talk",
                    "title": "Introduction",
                    "speakers": [{"name": "Lee Smith", "affiliation": ""}],
                    "abstract": "",
                    "videoUrl": "",
                    "videoId": None,
                    "slidesUrl": "",
                    "projectGithub": "",
                    "tags": [],
                },
                {
                    "id": "2012-04-12-003",
                    "meeting": "2012-04-12",
                    "meetingName": "2012 EuroLLVM Developers' Meeting",
                    "meetingLocation": "London, UK",
                    "meetingDate": "April 12, 2012",
                    "category": "technical-talk",
                    "title": "Improving Performance of OpenCL on CPUs",
                    "speakers": [{"name": "Ralf Karrenberg & Sebastian Hack", "affiliation": ""}],
                    "abstract": "",
                    "videoUrl": "",
                    "videoId": None,
                    "slidesUrl": "",
                    "projectGithub": "",
                    "tags": [],
                },
                {
                    "id": "2012-04-12-004",
                    "meeting": "2012-04-12",
                    "meetingName": "2012 EuroLLVM Developers' Meeting",
                    "meetingLocation": "London, UK",
                    "meetingDate": "April 12, 2012",
                    "category": "technical-talk",
                    "title": "What LLVM can do for you",
                    "speakers": [{"name": "David Chisnall", "affiliation": ""}],
                    "abstract": "",
                    "videoUrl": "",
                    "videoId": None,
                    "slidesUrl": "",
                    "projectGithub": "",
                    "tags": [],
                },
            ],
        }

        merged, changed, new_count = self.module.merge_meeting_talks(
            "2012-04-12",
            meeting,
            talks,
            existing_payload,
        )

        self.assertTrue(changed)
        self.assertEqual(new_count, 1)
        by_title = {talk["title"]: talk for talk in merged["talks"]}
        self.assertEqual(by_title["MCJIT"]["id"], "2012-04-12-002")
        self.assertEqual(
            [(speaker["name"], speaker["affiliation"]) for speaker in by_title["Improving Performance of OpenCL on CPUs"]["speakers"]],
            [("Ralf Karrenberg & Sebastian Hack", "")],
        )

    def test_select_remote_slugs_for_sync_only_includes_new_or_changed_meetings(self):
        selected = self.module.select_remote_slugs_for_sync(
            ["2026-04", "2025-04", "2025-03", "2024-10"],
            {"2025-04", "2025-03", "2024-10"},
            {"2025-03"},
        )
        self.assertEqual(selected, ["2026-04", "2025-03"])

    def test_derive_changed_devmtg_slugs_ignores_non_meeting_paths(self):
        changed = self.module.derive_changed_devmtg_slugs(
            [
                "devmtg/2026-04/index.html",
                "devmtg/2025-03/slides/foo.pdf",
                "devmtg/index.html",
                "docs/readme.md",
            ]
        )
        self.assertEqual(changed, {"2026-04", "2025-03"})

    def test_legacy_agenda_parser_handles_section_markers_and_malformed_video_hrefs(self):
        meeting, talks = self.module.parse_meeting_page(self.usdevmtg_2013_fixture_html, "2013-11")

        self.assertEqual(meeting["talkCount"], 3)
        by_title = {talk["title"]: talk for talk in talks}

        self.assertEqual(by_title["Welcome"]["videoUrl"], "https://youtu.be/GCsfjaAy7Es")
        self.assertEqual(
            [(speaker["name"], speaker["affiliation"]) for speaker in by_title["Welcome"]["speakers"]],
            [("Tanya Lattner", "LLVM Foundation")],
        )

        debug_bof = by_title["Debug Info"]
        self.assertEqual(debug_bof["category"], "bof")
        self.assertIsNone(debug_bof["videoUrl"])

        visual_cpp = by_title["Bringing clang and LLVM to Visual C++ users"]
        self.assertEqual(visual_cpp["videoUrl"], "https://youtu.be/u3sl2EwmbW0")
        self.assertEqual(
            [(speaker["name"], speaker["affiliation"]) for speaker in visual_cpp["speakers"]],
            [("Reid Kleckner", "Google")],
        )

    def test_legacy_video_slides_talk_tables_apply_shared_lightning_video(self):
        meeting, talks = self.module.parse_meeting_page(self.eurollvm_2015_fixture_html, "2015-04")

        self.assertEqual(meeting["talkCount"], 3)
        by_title = {talk["title"]: talk for talk in talks}

        intro = by_title["Introduction"]
        self.assertEqual(intro["videoUrl"], "https://youtu.be/sNDavmjNLQE")
        self.assertEqual(intro["slidesUrl"], None)

        keynote = by_title["C Concurrency: Still Tricky"]
        self.assertEqual(keynote["category"], "keynote")
        self.assertEqual(keynote["videoUrl"], "https://youtu.be/g8DUN8-AKgs")
        self.assertEqual(
            keynote["slidesUrl"],
            "https://llvm.org/devmtg/2015-04/slides/CConcurrency_EuroLLVM2015.pdf",
        )

        lightning = by_title["Building Clang/LLVM efficiently"]
        self.assertEqual(lightning["category"], "lightning-talk")
        self.assertEqual(lightning["videoUrl"], "https://youtu.be/tqkK9HRiVIc")
        self.assertEqual(
            lightning["slidesUrl"],
            "https://llvm.org/devmtg/2015-04/slides/eurollvm-2015-build.pdf",
        )

    def test_abs_devmtg_url_encodes_unsafe_path_characters(self):
        self.assertEqual(
            self.module.abs_devmtg_url("2013-11", "slides/Lattner-LLVM Early Days.pdf"),
            "https://llvm.org/devmtg/2013-11/slides/Lattner-LLVM%20Early%20Days.pdf",
        )


if __name__ == "__main__":
    unittest.main()
