import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class RepositoryDistributionTests(unittest.TestCase):
    def test_github_repository_contract(self):
        required = [
            ".github/workflows/test.yml", ".python-version", "README.md",
            "SKILL.md", "LICENSE", "requirements.txt", "pyproject.toml",
            "package.json", "package-lock.json", "agents/openai.yaml",
            "references/collection-guide.md", "scripts/facebook_playwright_collector.cjs",
        ]
        self.assertEqual([], [name for name in required if not (ROOT / name).is_file()])

    def test_dependencies_and_ignore_rules(self):
        requirements = (ROOT / "requirements.txt").read_text(encoding="utf-8")
        package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        ignored = (ROOT / ".gitignore").read_text(encoding="utf-8")
        self.assertIn("openpyxl", requirements)
        self.assertIn("playwright", package.get("dependencies", {}))
        for item in ("outputs/", "*Profile/", "*.xlsx", "*.jsonl", "node_modules/", "*.log"):
            self.assertIn(item, ignored)

    def test_ci_covers_portable_tests_and_skill_validation(self):
        workflow = (ROOT / ".github/workflows/test.yml").read_text(encoding="utf-8")
        for item in ("windows-latest", "macos-latest", "ubuntu-latest", "python -m unittest", "npm test", "quick_validate.py"):
            self.assertIn(item, workflow)


if __name__ == "__main__":
    unittest.main()