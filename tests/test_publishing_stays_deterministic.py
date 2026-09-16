"""The dashboard is ordinary software, and the guard is that it stays that way.

Nothing in the build-and-publish path may come to depend on a model, an agent, or
an API key. If it ever does, the dashboard stops being verifiable from the repo
alone and a failed agent run becomes a failed deployment. These tests fail before
that happens; they change no behaviour.
"""
import re
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
WORKFLOW = HERE / ".github" / "workflows" / "rebuild.yml"

# Files the published page is actually built from. The Worker is a separate
# runtime that serves the private desk; it is deliberately not in this list.
BUILD_PATH = ("build.py", "news.py")

# Markers that would mean the page can no longer be built without a model.
# Deliberately precise: the dashboard renders an agent-status panel from
# data.json, and "User-Agent" is an HTTP header, so neither word is a marker.
AGENT_MARKERS = (
    "anthropic", "openai", "api.anthropic.com", "api.openai.com",
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "langflow", "firecrawl",
    "claude-sonnet", "claude-opus", "gpt-4", "gpt-5",
    "modelcontextprotocol", "picks-mcp", "run_agent", "call_model",
)


def text(rel):
    return (HERE / rel).read_text(encoding="utf-8")


class PublishingPath(unittest.TestCase):
    def test_the_build_path_calls_no_model_and_needs_no_key(self):
        for rel in BUILD_PATH:
            body = text(rel).lower()
            for marker in AGENT_MARKERS:
                self.assertNotIn(marker.lower(), body, msg=f"{rel} references {marker}")

    def test_the_workflow_runs_only_deterministic_commands(self):
        body = text(WORKFLOW.relative_to(HERE))
        lowered = body.lower()
        for marker in AGENT_MARKERS:
            self.assertNotIn(marker.lower(), lowered, msg=f"the workflow references {marker}")

    def test_the_workflow_still_tests_before_it_builds(self):
        body = text(WORKFLOW.relative_to(HERE))
        checks = body.index("python3 -m unittest discover -s tests")
        node = body.index("node --test tests/*.test.mjs")
        build = body.index("python3 build.py")
        self.assertLess(checks, build, "the Python suite must run before the build")
        self.assertLess(node, build, "the Node suite must run before the build")

    def test_the_workflow_still_publishes_a_deployment_receipt(self):
        body = text(WORKFLOW.relative_to(HERE))
        self.assertIn("public/dashboard.json", body)
        self.assertIn("$GITHUB_SHA", body)
        self.assertIn("upload-pages-artifact", body)
        self.assertIn("deploy-pages", body)

    def test_publishing_needs_no_secret_beyond_the_pages_token(self):
        body = text(WORKFLOW.relative_to(HERE))
        secrets = set(re.findall(r"secrets\.([A-Za-z_][A-Za-z0-9_]*)", body))
        self.assertLessEqual(secrets, {"GITHUB_TOKEN"}, f"unexpected secrets: {sorted(secrets)}")

    def test_the_build_writes_the_published_files_itself(self):
        body = text(WORKFLOW.relative_to(HERE))
        self.assertIn("cp index.html data.json news.json public/", body)
        self.assertNotIn("agent-health", body)


if __name__ == "__main__":
    unittest.main()
