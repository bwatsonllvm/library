import importlib.util
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = REPO_ROOT / "scripts" / "sync-devmtg-from-llvm-www.py"
FIXTURE_PATH = REPO_ROOT / "tests" / "fixtures" / "devmtg" / "legacy-2011-snippet.html"


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

    def test_merge_meeting_talks_refreshes_broken_existing_speakers(self):
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

        self.assertTrue(changed)
        by_title = {talk["title"]: talk for talk in merged["talks"]}
        self.assertEqual(
            [(speaker["name"], speaker["affiliation"]) for speaker in by_title["LLVM MC In Practice"]["speakers"]],
            [("Jim Grosbach", "Apple"), ("Owen Anderson", "Apple")],
        )
        self.assertEqual(
            [(speaker["name"], speaker["affiliation"]) for speaker in by_title["Integrating LLVM into FreeBSD"]["speakers"]],
            [("Brooks Davis", "The FreeBSD Project")],
        )
        self.assertEqual(
            [(speaker["name"], speaker["affiliation"]) for speaker in by_title["PTX Back-End: GPU Programming With LLVM"]["speakers"]],
            [("Justin Holewinski", "Ohio State University")],
        )


if __name__ == "__main__":
    unittest.main()
