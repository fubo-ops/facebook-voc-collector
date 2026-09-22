#!/usr/bin/env python3
"""Minimal dependency-free Codex Skill frontmatter validator."""

import re
import sys
from pathlib import Path


def validate(root: Path) -> tuple[bool, str]:
    skill = root / "SKILL.md"
    if not skill.is_file():
        return False, "SKILL.md not found"
    text = skill.read_text(encoding="utf-8")
    match = re.match(r"^---\s*\n(.*?)\n---", text, re.DOTALL)
    if not match:
        return False, "Invalid YAML frontmatter"
    frontmatter = match.group(1)
    name = re.search(r"^name:\s*([^\n]+)$", frontmatter, re.MULTILINE)
    description = re.search(r"^description:\s*([^\n]+)$", frontmatter, re.MULTILINE)
    if not name or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name.group(1).strip()):
        return False, "Invalid or missing skill name"
    if not description or not description.group(1).strip():
        return False, "Missing description"
    return True, "Skill is valid!"


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python scripts/quick_validate.py <skill_directory>")
    valid, message = validate(Path(sys.argv[1]))
    print(message)
    raise SystemExit(0 if valid else 1)