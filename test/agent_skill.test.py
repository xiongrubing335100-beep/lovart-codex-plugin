import importlib.util
import pathlib
import unittest
from unittest import mock


SCRIPT_PATH = (
    pathlib.Path(__file__).resolve().parents[1]
    / "vendor"
    / "lovart-skill"
    / "scripts"
    / "agent_skill.py"
)
SPEC = importlib.util.spec_from_file_location("lovart_agent_skill", SCRIPT_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class FakePollingSkill(MODULE.AgentSkill):
    def __init__(self, results):
        self.timeout = 1
        self.poll_interval = 0
        self._results = list(results)
        self.result_calls = 0

    def get_status(self, thread_id):
        return {"status": "done"}

    def get_result(self, thread_id):
        index = min(self.result_calls, len(self._results) - 1)
        self.result_calls += 1
        return self._results[index]


class FakeResponse:
    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def read(self):
        return b"new artifact"


class AgentSkillRegressionTests(unittest.TestCase):
    def test_local_state_reads_legacy_windows_encoded_json(self):
        legacy = '{"active_project":"project-1","name":"测试项目"}'.encode("gb18030")

        data = MODULE.LocalState._decode_state_bytes(legacy)

        self.assertEqual(data["name"], "测试项目")

    def test_poll_waits_for_a_reused_thread_result_to_change(self):
        old_result = {"items": [{"type": "assistant", "text": "old", "artifacts": []}]}
        new_result = {
            "items": [
                {
                    "type": "assistant",
                    "text": "new",
                    "artifacts": [{"type": "image", "content": "https://example.test/new.png"}],
                }
            ]
        }
        skill = FakePollingSkill([old_result, new_result])

        with mock.patch.object(MODULE.time, "sleep", return_value=None):
            status = skill.poll("thread-1", baseline_result=old_result)

        self.assertEqual(status, "done")
        self.assertGreaterEqual(skill.result_calls, 2)

    def test_download_artifacts_excludes_urls_from_before_the_current_run(self):
        old_url = "https://example.test/old.png"
        new_url = "https://example.test/new.png"
        result = {
            "items": [
                {
                    "artifacts": [
                        {"type": "image", "content": old_url},
                        {"type": "image", "content": new_url},
                    ]
                }
            ]
        }

        with mock.patch("os.makedirs"), mock.patch("os.path.exists", return_value=False), \
                mock.patch("builtins.open", mock.mock_open()), \
                mock.patch.object(MODULE.urllib.request, "urlopen", return_value=FakeResponse()) as urlopen:
            downloaded = MODULE.AgentSkill.download_artifacts(
                result,
                output_dir="virtual-output",
                exclude_urls={old_url},
            )

        self.assertEqual([item["url"] for item in downloaded], [new_url])
        self.assertEqual(urlopen.call_count, 1)


if __name__ == "__main__":
    unittest.main()
