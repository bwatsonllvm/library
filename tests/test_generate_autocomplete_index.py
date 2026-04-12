import importlib.util
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = REPO_ROOT / "scripts" / "generate-autocomplete-index.py"


def load_module():
    spec = importlib.util.spec_from_file_location("generate_autocomplete_index", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class GenerateAutocompleteIndexTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = load_module()

    def test_iter_person_labels_splits_compound_names(self):
        labels = self.module.iter_person_labels("Andrey Bokhanko & Alexey Bataev")
        self.assertEqual(labels, ["Andrey Bokhanko", "Alexey Bataev"])

    def test_iter_person_labels_repairs_unmatched_affiliation(self):
        labels = self.module.iter_person_labels(
            "Kristóf Umann (Ericsson Hungary, Eötvös Loránd University"
        )
        self.assertEqual(labels, ["Kristóf Umann"])

    def test_iter_person_labels_repairs_short_parenthetical_affiliation(self):
        labels = self.module.iter_person_labels("Bernhard Rosenkränzer (Linaro")
        self.assertEqual(labels, ["Bernhard Rosenkränzer"])

    def test_iter_person_labels_preserves_shared_affiliation_pairs(self):
        labels = self.module.iter_person_labels(
            "Virgile Prevosto and Franck Védrine (CEA LIST)"
        )
        self.assertEqual(labels, ["Virgile Prevosto", "Franck Védrine"])

    def test_iter_person_labels_applies_known_person_aliases(self):
        self.assertEqual(self.module.iter_person_labels("Alex Zinenko"), ["Oleksandr Zinenko"])
        self.assertEqual(self.module.iter_person_labels("Owen T. Anderson"), ["Owen Anderson"])


if __name__ == "__main__":
    unittest.main()
