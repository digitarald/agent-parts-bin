import contextlib
from copy import deepcopy
import getpass
import http.client
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
ENDPOINT = "https://example-resource.services.ai.azure.com"
SPEC = importlib.util.spec_from_file_location("decide", ROOT / "scripts" / "decide.py")
decide = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(decide)


class DecideTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.environment = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                            "XDG_CONFIG_HOME": self.temporary.name,
                            "DECIDE_ENDPOINT": ENDPOINT, "DECIDE_API_KEY": "test-key"}
        environment = patch.dict(os.environ, self.environment, clear=True)
        environment.start()
        self.addCleanup(environment.stop)
        self.batch = json.loads((ROOT / "assets" / "triage.json").read_text())
        self.response = {
            "model": "microsoft-decision-1",
            "answers": {
                "repeat_contact": {"type": "noul", "noul": 0.9},
                "team": {"type": "choice", "choice": "engineering", "confidence": 0.9,
                         "probabilities": {"engineering": 0.9, "billing": 0.05, "unknown": 0.05}},
                "severity": {"type": "score", "score": 2.8,
                             "probabilities": {"0": 0.0, "1": 0.0, "2": 0.2, "3": 0.8},
                             "legend": {"0": "Cosmetic", "1": "Minor", "2": "Major", "3": "Critical"}},
            },
            "usage": {"input_tokens": 123, "output_tokens": 0},
        }

    def test_configured_directory_does_not_require_a_user_home(self):
        with patch.object(Path, "home", side_effect=RuntimeError("No user home")):
            self.assertEqual(decide.config_path(), Path(self.temporary.name) / "decide" / "config.json")

    def test_batch_and_all_convenience_commands_build_api_shapes(self):
        invocations = [
            (["bool", "--question", "Is it down?", "--state", "Down"], "noul", None),
            (["choice", "--question", "Which?", "--state", "Down",
              "--option", "a=Outage", "--option", "b=Billing"], "choice", {"a": "Outage", "b": "Billing"}),
            (["score", "--question", "Severity?", "--state", "Down",
              "--level", "Low", "--level", "High"], "score", ["Low", "High"]),
        ]
        for argv, kind, criteria in invocations:
            with self.subTest(kind=kind):
                request = decide.request_from_args(decide.parser().parse_args(argv))
                question = request["questions"]["decision"]
                self.assertEqual(question["type"], kind)
                self.assertEqual(question.get("criteria"), criteria)
        args = decide.parser().parse_args(["batch", "--input", str(ROOT / "assets" / "triage.json")])
        self.assertEqual(decide.request_from_args(args), {"model": "Decision-1", **self.batch})

    def test_preserves_probabilities_and_threshold_boundary(self):
        result = decide.normalize_response(self.response, self.batch["questions"], 0.9)
        self.assertTrue(result["answers"]["repeat_contact"]["value"])
        self.assertEqual(result["answers"]["severity"]["value"], 2.8)
        self.assertEqual(result["answers"]["team"]["probabilities"],
                         self.response["answers"]["team"]["probabilities"])
        result = decide.normalize_response(self.response, self.batch["questions"], 0.91)
        self.assertFalse(result["answers"]["repeat_contact"]["value"])

    def test_captured_response_can_be_parsed_without_inferred_field_names(self):
        response = json.loads((ROOT / "assets" / "triage-response-full.json").read_text())
        with patch.object(decide, "call_api", return_value=(response, response["latency_ms"])):
            code, stdout, stderr = self.invoke(["batch", "--input", str(ROOT / "assets" / "triage.json"), "--full"])
        self.assertEqual(code, 0, stderr)
        result = json.loads(stdout)
        self.assertEqual(result, response)
        self.assertGreater(result["answers"]["repeat_contact"]["noul"], 0.5)
        team = result["answers"]["team"]
        self.assertGreater(team["probabilities"][team["choice"]], 0.9)
        self.assertNotEqual(team["probabilities"][team["choice"]], team["confidence"])
        self.assertEqual(set(result["answers"]["severity"]["probabilities"]),
                         set(result["answers"]["severity"]["legend"]))

    def test_compact_default_keeps_only_values_and_selected_choice_probability(self):
        response = json.loads((ROOT / "assets" / "triage-response-full.json").read_text())
        expected = json.loads((ROOT / "assets" / "triage-response.json").read_text())
        with patch.object(decide, "call_api", return_value=(response, response["latency_ms"])):
            code, stdout, stderr = self.invoke(["batch", "--input", str(ROOT / "assets" / "triage.json")])
        self.assertEqual(code, 0, stderr)
        self.assertEqual(json.loads(stdout), expected)
        self.assertEqual(stderr, "")
        self.assertEqual(stdout.count("\n"), 1)

    def test_single_choice_default_and_scalar_override_preserve_distinct_probabilities(self):
        choice = self.response["answers"]["team"]
        choice["confidence"] = 0.8
        response = {**self.response, "answers": {"decision": choice}}
        args = ["choice", "--question", "Q", "--state", "S", "--option", "engineering=Bugs",
                "--option", "billing=Invoices", "--option", "unknown=Insufficient evidence"]
        with patch.object(decide, "call_api", return_value=(response, 1.0)):
            code, stdout, stderr = self.invoke(args)
            self.assertEqual(code, 0, stderr)
            self.assertEqual(json.loads(stdout), {"decision": {"value": "engineering", "probability": 0.9}})
            code, stdout, stderr = self.invoke([*args, "--value"])
            self.assertEqual(code, 0, stderr)
            self.assertEqual(json.loads(stdout), "engineering")

    def test_compact_boolean_threshold_and_score_do_not_round(self):
        self.response["answers"]["repeat_contact"]["noul"] = 0.50000001
        self.response["answers"]["severity"]["score"] = 2.800000001
        args = ["batch", "--input", str(ROOT / "assets" / "triage.json"), "--threshold", "0.50000002"]
        with patch.object(decide, "call_api", return_value=(self.response, 1.0)):
            code, stdout, stderr = self.invoke(args)
        self.assertEqual(code, 0, stderr)
        self.assertIs(json.loads(stdout)["repeat_contact"], False)
        self.assertEqual(json.loads(stdout)["severity"], 2.800000001)

    def test_dry_run_emits_request_not_response_and_never_authenticates(self):
        with patch.object(decide, "auth_headers") as auth, patch.object(decide, "call_api") as api:
            code, stdout, stderr = self.invoke(["batch", "--input", str(ROOT / "assets" / "triage.json"), "--dry-run"])
        self.assertEqual(code, 0, stderr)
        self.assertEqual(json.loads(stdout), {"model": "Decision-1", **self.batch})
        auth.assert_not_called()
        api.assert_not_called()

    def test_error_details_are_nested_and_api_failure_is_not_retried(self):
        failure = decide.DecisionError(4, "Throttled.", "Retry with backoff.", http_status=429, retry_after_seconds=2)
        with patch.object(decide, "call_api", side_effect=failure) as api:
            code, stdout, stderr = self.invoke(["bool", "--question", "Q", "--state", "S", "--non-interactive"])
        self.assertEqual(code, 4)
        self.assertEqual(stdout, "")
        self.assertEqual(json.loads(stderr), {"schema_version": 1, "error": {
            "exit_code": 4, "message": "Throttled.", "hint": "Retry with backoff.", "retryable": True,
            "http_status": 429, "retry_after_seconds": 2,
        }})
        api.assert_called_once()

    def test_rejects_missing_malformed_and_out_of_range_answers(self):
        cases = [
            ("repeat_contact", "noul", True), ("repeat_contact", "noul", float("nan")),
            ("repeat_contact", "noul", 10 ** 400),
            ("team", "choice", "invented"), ("team", "probabilities", {"engineering": 1.0}),
            ("severity", "score", 4), ("severity", "score", -0.1),
        ]
        for name, field, value in cases:
            with self.subTest(name=name, field=field, value=value):
                payload = deepcopy(self.response)
                payload["answers"][name][field] = value
                with self.assertRaises(decide.DecisionError) as raised:
                    decide.normalize_response(payload, self.batch["questions"], 0.5)
                self.assertEqual(raised.exception.code, 5)
        del self.response["answers"]["team"]
        with self.assertRaises(decide.DecisionError):
            decide.normalize_response(self.response, self.batch["questions"], 0.5)

    def test_invalid_cli_emits_json_stderr_without_network(self):
        cases = [
            ["noul", "--question", "Q", "--state", "S", "--threshold", "nan"],
            ["score", "--question", "Q", "--state", "S", "--level", "Only one"],
            ["choice", "--question", "Q", "--state", "S", "--option", "a=X", "--option", "a=Y"],
            ["noul", "--question", "Q"],
            ["noul", "--question", "Q", "--state", "S", "--full", "--value"],
            ["noul", "--question", "Q", "--state", "S", "--full", "--dry-run"],
        ]
        for argv in cases:
            with self.subTest(argv=argv), patch.object(decide, "call_api") as api:
                stdout, stderr = io.StringIO(), io.StringIO()
                with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                    code = decide.main(argv)
                self.assertEqual(code, 2)
                self.assertEqual(stdout.getvalue(), "")
                self.assertEqual(json.loads(stderr.getvalue())["error"]["exit_code"], 2)
                api.assert_not_called()
        for raw in ('{"state":NaN}', '{"state":"a","state":"b"}'):
            with self.assertRaises(decide.DecisionError):
                decide.parse_json(raw)

    def test_dry_run_and_schema_need_no_credentials(self):
        for args in (["schema"], ["noul", "--question", "Q", "--state", "S", "--dry-run"]):
            result = subprocess.run([sys.executable, str(ROOT / "scripts" / "decide.py"), *args],
                                    capture_output=True, text=True,
                                    env={"PATH": "/usr/bin:/bin", "XDG_CONFIG_HOME": self.temporary.name})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stderr, "")
            self.assertIsInstance(json.loads(result.stdout), dict)

    def test_http_errors_are_actionable_and_do_not_echo_remote_body(self):
        body = {"model": "Decision-1", **self.batch}
        for status, expected in ((401, 3), (403, 3), (404, 5), (422, 5), (429, 4), (503, 4)):
            error = urllib.error.HTTPError(ENDPOINT, status, "private", {"Retry-After": "2"},
                                          io.BytesIO(b"SECRET request and key"))
            with self.subTest(status=status):
                with patch("urllib.request.OpenerDirector.open", side_effect=error):
                    with self.assertRaises(decide.DecisionError) as raised:
                        decide.call_api(body, 1, ENDPOINT, {"api-key": "SECRET"})
            self.assertEqual(raised.exception.code, expected)
            self.assertNotIn("SECRET", json.dumps(raised.exception.error))
            self.assertEqual(raised.exception.error["retry_after_seconds"], 2)

    def test_explicit_stdin_and_value_false_are_json(self):
        request = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "decide.py"), "batch", "--input", "-", "--dry-run"],
            input=json.dumps(self.batch), capture_output=True, text=True,
        )
        self.assertEqual(request.returncode, 0, request.stderr)
        self.assertEqual(json.loads(request.stdout)["state"], self.batch["state"])
        payload = {"model": "test", "answers": {"decision": {"type": "noul", "noul": 0.1}},
                   "usage": {"input_tokens": 1, "output_tokens": 0}}
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(decide, "call_api", return_value=(payload, 1.0)):
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                self.assertEqual(decide.main(["bool", "--question", "Q", "--state", "S", "--value"]), 0)
        self.assertIs(json.loads(stdout.getvalue()), False)
        self.assertEqual(stderr.getvalue(), "")

    def test_interrupted_response_is_a_transient_error_without_retry(self):
        body = {"model": "Decision-1", **self.batch}
        with patch("urllib.request.OpenerDirector.open", side_effect=http.client.IncompleteRead(b"partial")) as send:
            with self.assertRaises(decide.DecisionError) as raised:
                decide.call_api(body, 1, ENDPOINT, {"api-key": "test"})
        self.assertEqual(raised.exception.code, 4)
        send.assert_called_once()

    def test_invalid_environment_credential_fails_without_exposing_it(self):
        for secret in ("", "a\nb", "non-ascii-\u2603", "has spaces"):
            with self.subTest(secret=secret), patch.dict("os.environ", {"DECIDE_API_KEY": secret}, clear=True):
                with self.assertRaises(decide.DecisionError) as raised:
                    decide.auth_headers(ENDPOINT)
                self.assertEqual(raised.exception.code, 3)
                self.assertEqual(raised.exception.error["message"], "DECIDE_API_KEY is empty or invalid.")

    def invoke(self, argv):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = decide.main(argv)
        return code, stdout.getvalue(), stderr.getvalue()

    def test_setup_stores_key_via_stdin_and_only_metadata_in_config(self):
        secret = "test-secret"
        store = {}
        calls = []

        def security(command, **kwargs):
            calls.append((command, kwargs))
            if command == ["/usr/bin/security", "-i"]:
                tokens = kwargs["input"].split()
                store[tokens[tokens.index("-s") + 1]] = bytes.fromhex(tokens[-1]).decode("ascii")
                return subprocess.CompletedProcess(command, 0, "", "")
            service = command[command.index("-s") + 1]
            return subprocess.CompletedProcess(command, 0 if service in store else 44,
                                               store.get(service, ""), "")

        with patch("sys.platform", "darwin"), patch.object(decide, "human_terminal", return_value=True):
            with patch("sys.stdin", io.StringIO("\n")), patch("getpass.getpass", return_value=secret):
                with patch("subprocess.run", side_effect=security):
                    code, stdout, stderr = self.invoke(["setup"])
        self.assertEqual(code, 0, stderr)
        result = json.loads(stdout)
        self.assertTrue(result["configured"])
        self.assertEqual(result["credential_source"], "macos-keychain")
        self.assertEqual(decide.load_config(), {"endpoint": ENDPOINT, "deployment": "Decision-1"})
        self.assertNotIn(secret, stdout + stderr + decide.config_path().read_text())
        self.assertNotIn(secret, str([command for command, _ in calls]))
        self.assertNotIn(secret.encode().hex(), str([command for command, _ in calls]))
        if os.name != "nt":
            self.assertEqual(decide.config_path().stat().st_mode & 0o777, 0o600)
        self.assertEqual(store, {"decide:example-resource": secret})

    def test_setup_keeps_existing_key_and_accepts_explicit_piped_key(self):
        with patch("sys.platform", "darwin"), patch.object(decide, "human_terminal", return_value=True):
            with patch.object(decide, "read_keychain", return_value="existing-key"):
                with patch.object(decide, "save_keychain") as save:
                    with patch("sys.stdin", io.StringIO("\n")), patch("getpass.getpass", return_value=""):
                        code, _, stderr = self.invoke(["setup"])
                    self.assertEqual(code, 0, stderr)
                    save.assert_not_called()
            source = io.TextIOWrapper(io.BytesIO(b"replacement-key\n"))
            with patch("sys.stdin", source), patch.object(decide, "save_keychain") as save:
                code, stdout, stderr = self.invoke(["setup", "--endpoint", ENDPOINT, "--key-stdin"])
                self.assertEqual(code, 0, stderr)
                self.assertNotIn("replacement-key", stdout + stderr)
                save.assert_called_once_with(ENDPOINT, "replacement-key")

    def test_missing_setup_never_prompts_in_agent_or_piped_runs(self):
        for flag, terminal in ((["--non-interactive"], True), ([], False)):
            with self.subTest(flag=flag), patch.dict(os.environ, {"XDG_CONFIG_HOME": self.temporary.name}, clear=True):
                with patch.object(decide, "human_terminal", return_value=terminal):
                    with patch.object(decide, "run_setup") as setup, patch.object(decide, "call_api") as api:
                        code, stdout, stderr = self.invoke(["bool", "--question", "Q", "--state", "S", *flag])
                        self.assertEqual(code, 3)
                        self.assertEqual(stdout, "")
                        self.assertTrue(json.loads(stderr)["error"]["setup_required"])
                        setup.assert_not_called()
                        api.assert_not_called()

    def test_api_key_without_endpoint_never_uses_a_bundled_resource(self):
        environment = {"XDG_CONFIG_HOME": self.temporary.name, "DECIDE_API_KEY": "test-key"}
        with patch.dict(os.environ, environment, clear=True):
            with patch.object(decide, "call_api") as api:
                code, stdout, stderr = self.invoke(
                    ["bool", "--question", "Q", "--state", "S", "--non-interactive"])
        self.assertEqual(code, 3)
        self.assertEqual(stdout, "")
        self.assertTrue(json.loads(stderr)["error"]["setup_required"])
        api.assert_not_called()

    def test_first_use_sets_up_once_then_uses_new_deployment(self):
        configured = {"endpoint": ENDPOINT, "deployment": "my-decision"}
        payload = {"model": "test", "answers": {"decision": {"type": "noul", "noul": 0.1}},
                   "usage": {"input_tokens": 1, "output_tokens": 0}}
        with patch.dict(os.environ, {"XDG_CONFIG_HOME": self.temporary.name}, clear=True):
            with patch.object(decide, "human_terminal", return_value=True):
                with patch.object(decide, "run_setup", side_effect=lambda args: decide.save_config(configured)) as setup:
                    with patch.object(decide, "auth_headers", return_value={"api-key": "test-key"}):
                        with patch.object(decide, "call_api", return_value=(payload, 1.0)) as api:
                            code, stdout, stderr = self.invoke(["bool", "--question", "Q", "--state", "S", "--value"])
        self.assertEqual(code, 0, stderr)
        self.assertEqual(json.loads(stdout), False)
        setup.assert_called_once()
        self.assertEqual(api.call_args.args[0]["model"], "my-decision")
        self.assertEqual(api.call_args.args[2], ENDPOINT)
        api.assert_called_once()

    def test_linux_setup_guides_environment_entry_without_saving_a_key(self):
        env = {"XDG_CONFIG_HOME": self.temporary.name, "DECIDE_ENDPOINT": ENDPOINT}
        with patch.dict(os.environ, env, clear=True), patch("sys.platform", "linux"):
            with patch.object(decide, "human_terminal", return_value=True), patch("getpass.getpass") as hidden:
                with patch("sys.stdin", io.StringIO("\n")):
                    code, stdout, stderr = self.invoke(["setup"])
                self.assertEqual(code, 3)
                self.assertEqual(stdout, "")
                error = json.loads(stderr[stderr.index('{"schema_version"'):])["error"]
                self.assertTrue(error["setup_required"])
                self.assertIn("Read-Host", error["hint"])
                self.assertEqual(set(decide.load_config()), {"endpoint", "deployment"})
                os.environ["DECIDE_API_KEY"] = "environment-key"
                with patch("sys.stdin", io.StringIO("\n")):
                    code, stdout, stderr = self.invoke(["setup"])
                self.assertEqual(code, 0, stderr)
                self.assertEqual(json.loads(stdout)["credential_source"], "environment")
                self.assertNotIn("environment-key", decide.config_path().read_text())
                hidden.assert_not_called()

    def test_setup_cancellation_or_failed_keychain_write_leaves_config_unchanged(self):
        original = {"endpoint": ENDPOINT, "deployment": "previous-deployment"}
        decide.save_config(original)
        for error in (EOFError(), getpass.GetPassWarning("Echo would be enabled")):
            with self.subTest(error=type(error).__name__), patch("sys.platform", "darwin"):
                with patch.object(decide, "human_terminal", return_value=True), patch("sys.stdin", io.StringIO("\n")):
                    with patch.object(decide, "read_keychain", return_value=None):
                        with patch("getpass.getpass", side_effect=error), patch.object(decide, "save_keychain") as save:
                            code, stdout, _ = self.invoke(["setup"])
                            self.assertIn(code, (3, 130))
                            self.assertEqual(stdout, "")
                            save.assert_not_called()
                            self.assertEqual(decide.load_config(), original)
        with patch("subprocess.run", return_value=subprocess.CompletedProcess([], 1, "", "SECRET")):
            with self.assertRaises(decide.DecisionError) as raised:
                decide.save_keychain(ENDPOINT, "test-secret")
            self.assertNotIn("SECRET", json.dumps(raised.exception.error))
        self.assertEqual(decide.load_config(), original)

    def test_endpoint_overrides_are_validated_and_keychain_scoped(self):
        for endpoint in ("http://example.services.ai.azure.com", ENDPOINT + "/api/projects/test",
                         ENDPOINT + ".evil.example", ENDPOINT + "?key=private"):
            with self.subTest(endpoint=endpoint), self.assertRaises(decide.DecisionError):
                decide.resource_endpoint(endpoint)
        other = "https://other-resource.services.ai.azure.com"
        config = {"endpoint": ENDPOINT, "deployment": "saved"}
        args = decide.parser().parse_args(["bool", "--question", "Q", "--state", "S", "--endpoint", other])
        self.assertEqual(decide.setting(args, "endpoint", config), other)
        self.assertNotEqual(decide.keychain_service(other), decide.keychain_service(ENDPOINT))
        with patch("sys.platform", "darwin"), patch.dict(os.environ, {}, clear=True):
            with patch("subprocess.run", return_value=subprocess.CompletedProcess([], 44, "", "")) as read:
                with self.assertRaises(decide.SetupRequired):
                    decide.auth_headers(other)
                self.assertIn("decide:other-resource", read.call_args.args[0])


if __name__ == "__main__":
    unittest.main()
