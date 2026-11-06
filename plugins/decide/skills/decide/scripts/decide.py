#!/usr/bin/env python3
"""Bounded decisions through Microsoft-Decision-1. Python 3.10+, standard library only."""

import argparse
import getpass
import http.client
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import warnings

MAX_INPUT = 128 * 1024
MAX_RESPONSE = 1024 * 1024
EXIT_CODES = {
    "0": "Valid result (a false decision is also success)",
    "2": "Invalid arguments or input; fix the request",
    "3": "Missing or rejected credentials; fix authentication",
    "4": "Transient network, throttling, or server error; caller may retry",
    "5": "Invalid response or other upstream failure; investigate",
    "130": "Interrupted",
}


class DecisionError(Exception):
    def __init__(self, code, message, hint, **details):
        super().__init__(message)
        self.code = code
        self.error = {
            "message": message,
            "hint": hint,
            "retryable": code == 4,
            **details,
        }


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise DecisionError(2, message, "Run decide.py <command> --help.")


class SetupRequired(DecisionError):
    def __init__(self, message):
        super().__init__(3, message, "Run decide.py setup in your terminal, not through an agent. Never paste secrets into chat.",
                         setup_required=True)


def emit(value, stream=None):
    print(json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(",", ":")),
          file=sys.stdout if stream is None else stream)


def require(condition, message, code=2):
    if not condition:
        raise DecisionError(code, message, "Run decide.py schema for the contract.")


def text(value):
    return isinstance(value, str) and bool(value.strip())


def number(value, lower, upper):
    return type(value) in (int, float) and lower <= value <= upper and math.isfinite(value)


def human_terminal():
    return sys.stdin.isatty() and sys.stderr.isatty() and not os.environ.get("CI")


def config_path():
    return Path(os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config"))) / "decide" / "config.json"


def load_config():
    path = config_path()
    try:
        with path.open("rb") as source:
            config = json.loads(source.read(MAX_INPUT + 1), object_pairs_hook=unique_object,
                                parse_constant=reject_constant)
    except FileNotFoundError:
        return {}
    except (OSError, ValueError, UnicodeError, RecursionError) as exc:
        raise DecisionError(3, f"Cannot read valid configuration at {path}.",
                            "Fix or move this file, then run decide.py setup.") from exc
    require(isinstance(config, dict) and set(config) == {"endpoint", "deployment"}
            and all(text(v) for v in config.values()), f"Invalid configuration at {path}.", 3)
    return config


def save_config(config):
    path = config_path()
    temporary = None
    try:
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, prefix=".config-", delete=False) as target:
            temporary = Path(target.name)
            json.dump(config, target)
            target.write("\n")
        os.replace(temporary, path)
        temporary = None
    except OSError as exc:
        raise DecisionError(3, f"Cannot save configuration at {path}.", "Check directory permissions and rerun setup.") from exc
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def setting(args, name, config, default=None):
    explicit = getattr(args, name)
    if explicit is not None:
        return explicit
    return os.environ.get("DECIDE_" + name.upper(), config.get(name, default))


def resource_endpoint(value):
    if value is None:
        raise SetupRequired("No Foundry resource endpoint configured.")
    require(isinstance(value, str), "Endpoint must be a URL.", 3)
    value = value.strip().lower().rstrip("/")
    require(re.fullmatch(r"https://[a-z0-9][a-z0-9-]*\.services\.ai\.azure\.com", value),
            "Use an HTTPS Foundry resource URL: https://RESOURCE.services.ai.azure.com (no project/API path).", 3)
    return value


def keychain_service(endpoint):
    return "decide:" + endpoint.split("://", 1)[1].split(".", 1)[0]


def validate_secret(value, label="API key"):
    require(bool(value) and all(33 <= ord(char) <= 126 for char in value),
            f"{label} is empty or invalid.", 3)
    return value


def read_keychain(endpoint):
    try:
        result = subprocess.run(
            ["/usr/bin/security", "find-generic-password", "-s", keychain_service(endpoint), "-a", "api-key", "-w"],
            capture_output=True, text=True, timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise DecisionError(3, "Cannot read the decide Keychain item.",
                            "Unlock Keychain yourself, or set DECIDE_API_KEY.") from exc
    if result.returncode == 44:
        return None
    if result.returncode != 0:
        raise DecisionError(3, "Keychain access failed.", "Unlock Keychain yourself and retry; no credential was printed.")
    return validate_secret(result.stdout.strip(), "Keychain credential")


def save_keychain(endpoint, secret):
    validate_secret(secret)
    # Hex goes through stdin, not process arguments; it also avoids command-token quoting.
    command = f"add-generic-password -U -s {keychain_service(endpoint)} -a api-key -X {secret.encode('ascii').hex()}\n"
    try:
        result = subprocess.run(["/usr/bin/security", "-i"], input=command, capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise DecisionError(3, "Cannot save the API key.", "Unlock Keychain yourself and rerun setup.") from exc
    if result.returncode != 0 or read_keychain(endpoint) != secret:
        raise DecisionError(3, "Could not verify Keychain storage.", "Unlock Keychain yourself and rerun setup.")


def prompt(label, default=None):
    print(label + (f" [{default}]" if default else "") + ": ", file=sys.stderr, end="", flush=True)
    value = sys.stdin.readline()
    if not value:
        raise EOFError
    return value.strip() or default


def run_setup(args):
    config = load_config()
    endpoint = setting(args, "endpoint", config)
    deployment = setting(args, "deployment", config, "Decision-1")
    key_stdin = getattr(args, "key_stdin", False)
    if not key_stdin:
        if not human_terminal():
            raise SetupRequired("Setup needs a human terminal. For automation on macOS, use setup --endpoint URL --key-stdin.")
        print("Copy the resource URL and API key from your Foundry deployment's Details page.\n"
              "Use https://RESOURCE.services.ai.azure.com, not a project or OpenAI URL.\n"
              "Setup stores configuration locally and makes no billable API calls.", file=sys.stderr)
        if args.endpoint is None and "DECIDE_ENDPOINT" not in os.environ:
            endpoint = prompt("Foundry resource URL", endpoint)
        if args.deployment is None and "DECIDE_DEPLOYMENT" not in os.environ:
            deployment = prompt("Deployment name", deployment)
    endpoint = resource_endpoint(endpoint)
    require(text(deployment), "Deployment name must not be empty.", 3)
    config = {"endpoint": endpoint, "deployment": deployment}
    if sys.platform == "darwin":
        if key_stdin:
            save_keychain(endpoint, read_input("-").strip())
        else:
            existing = read_keychain(endpoint)
            print("The API key will be stored in macOS Keychain, never in the skill or config file.", file=sys.stderr)
            try:
                with warnings.catch_warnings():
                    warnings.simplefilter("error", getpass.GetPassWarning)
                    secret = getpass.getpass("API key (hidden)" + (" [Enter to keep saved key]" if existing else "") + ": ",
                                            stream=sys.stderr)
            except getpass.GetPassWarning as exc:
                raise DecisionError(3, "Hidden key entry is unavailable.", "Run setup in a real terminal; do not paste a key here.") from exc
            if secret or not existing:
                save_keychain(endpoint, secret)
        credential_source = "macos-keychain"
        save_config(config)
    else:
        require(not key_stdin, "--key-stdin storage is supported only on macOS. Use DECIDE_API_KEY here.", 3)
        save_config(config)
        try:
            auth_headers(endpoint)
        except SetupRequired as exc:
            raise DecisionError(
                3, "Endpoint saved; set DECIDE_API_KEY in your shell to finish setup.",
                'Bash: read -rs -p "API key: " DECIDE_API_KEY; export DECIDE_API_KEY; printf "\\n"\n'
                'PowerShell: $env:DECIDE_API_KEY = [System.Net.NetworkCredential]::new("", '
                '(Read-Host "API key" -AsSecureString)).Password\n'
                "The key is hidden and lasts for this shell session. Rerun setup after setting it.",
                setup_required=True,
            ) from exc
        credential_source = "environment"
    return {"schema_version": 1, "configured": True, **config, "credential_source": credential_source,
            "config_file": str(config_path())}


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate JSON key: {key}")
        result[key] = value
    return result


def reject_constant(value):
    raise ValueError(f"Non-finite JSON number: {value}")


def parse_json(raw):
    try:
        return json.loads(raw, object_pairs_hook=unique_object, parse_constant=reject_constant)
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise DecisionError(2, "Invalid JSON input.", "Use strict JSON without duplicate keys or NaN.") from exc


def read_input(path):
    try:
        if path == "-":
            require(not sys.stdin.isatty(), "Stdin is a terminal; pipe input or provide a file.")
            raw = sys.stdin.buffer.read(MAX_INPUT + 1)
        else:
            with Path(path).expanduser().open("rb") as source:
                raw = source.read(MAX_INPUT + 1)
        require(len(raw) <= MAX_INPUT, "Input exceeds the local 128 KiB limit.")
        return raw.decode("utf-8")
    except (OSError, UnicodeError) as exc:
        raise DecisionError(2, f"Cannot read UTF-8 input: {path}", "Check the path, permissions, and encoding.") from exc


def validate_request(payload):
    require(isinstance(payload, dict), "Batch input must be an object.")
    require(set(payload) == {"state", "questions"}, "Input must contain only state and questions.")
    state = payload["state"]
    require(text(state) or isinstance(state, (dict, list)) and bool(state),
            "State must be nonempty text, an object, or an array.")
    questions = payload["questions"]
    require(isinstance(questions, dict) and 1 <= len(questions) <= 32,
            "Provide 1 to 32 named questions per request (local limit).")
    for name, question in questions.items():
        require(text(name) and isinstance(question, dict), "Each named question must be an object.")
        require(not set(question) - {"type", "instructions", "criteria"}, f"Unknown fields in question {name}.")
        kind = question.get("type")
        require(kind in ("noul", "choice", "score"), f"Unsupported type in question {name}.")
        require(text(question.get("instructions")), f"Question {name} needs instructions.")
        criteria = question.get("criteria")
        if kind == "noul":
            require("criteria" not in question or isinstance(criteria, dict) and bool(criteria)
                    and set(criteria) <= {"true", "false"} and all(text(v) for v in criteria.values()),
                    f"Question {name}: noul criteria must describe true and/or false.")
        elif kind == "choice":
            require(isinstance(criteria, dict) and 2 <= len(criteria) <= 255
                    and all(text(k) and text(v) for k, v in criteria.items()),
                    f"Question {name}: provide 2 to 255 distinct options with descriptions.")
        else:
            require(isinstance(criteria, list) and 2 <= len(criteria) <= 10
                    and all(text(v) for v in criteria) and len(set(criteria)) == len(criteria),
                    f"Question {name}: provide 2 to 10 distinct levels, lowest to highest.")
    return payload


def request_from_args(args):
    if args.command == "batch":
        payload = parse_json(read_input(args.input))
    else:
        state = read_input(args.state_file) if args.state_file is not None else args.state
        kind = "noul" if args.command == "bool" else args.command
        question = {"type": kind, "instructions": args.question}
        if kind == "noul":
            criteria = {key: value for key, value in (("true", args.true), ("false", args.false))
                        if value is not None}
            if criteria:
                question["criteria"] = criteria
        elif kind == "choice":
            criteria = {}
            for option in args.option:
                label, separator, description = option.partition("=")
                require(separator and text(label) and text(description),
                        "Each --option must be LABEL=description.")
                require(label not in criteria, f"Duplicate option: {label}")
                criteria[label] = description
            question["criteria"] = criteria
        else:
            question["criteria"] = args.level
        payload = {"state": state, "questions": {"decision": question}}
    validate_request(payload)
    require(number(args.timeout, 0.1, 120), "--timeout must be between 0.1 and 120 seconds.")
    require(number(args.threshold, 0, 1), "--threshold must be between 0 and 1.")
    require(not args.value or len(payload["questions"]) == 1, "--value requires exactly one question.")
    require(not ((args.value or args.full) and args.dry_run), "--value/--full cannot be combined with --dry-run.")
    body = {"model": args.deployment if args.deployment is not None else "Decision-1", **payload}
    encode_request(body)
    return body


def encode_request(body):
    require(text(body["model"]), "Deployment name must not be empty.")
    try:
        encoded = json.dumps(body, allow_nan=False).encode("utf-8")
    except (ValueError, RecursionError) as exc:
        raise DecisionError(2, "Input is not finite JSON.", "Remove non-finite numbers or excessive nesting.") from exc
    require(len(encoded) <= MAX_INPUT, "Request exceeds the local 128 KiB limit.")
    return encoded


def auth_headers(endpoint):
    for variable, header, prefix in (
        ("DECIDE_API_KEY", "api-key", ""),
        ("AZURE_API_KEY", "api-key", ""),
        ("DECIDE_TOKEN", "Authorization", "Bearer "),
        ("AZURE_ENTRA_TOKEN", "Authorization", "Bearer "),
    ):
        if variable in os.environ:
            value = validate_secret(os.environ[variable].strip(), variable)
            return {header: prefix + value}
    if sys.platform != "darwin":
        raise SetupRequired("No credential configured. Set DECIDE_API_KEY or DECIDE_TOKEN.")
    secret = read_keychain(endpoint)
    if secret is None:
        raise SetupRequired("No saved API key for this Foundry resource.")
    return {"api-key": secret}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise DecisionError(5, "Refusing an API redirect.", "Verify the configured Foundry endpoint.")


def call_api(body, timeout, endpoint, headers):
    request = urllib.request.Request(
        endpoint + "/providers/microsoft/v1/systemone",
        data=encode_request(body),
        headers={"Content-Type": "application/json", "Accept": "application/json", **headers},
        method="POST",
    )
    start = time.perf_counter()
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=timeout) as response:
            raw = response.read(MAX_RESPONSE + 1)
    except urllib.error.HTTPError as exc:
        status = exc.code
        retry_after = exc.headers.get("Retry-After", "")
        exc.close()
        code = 3 if status in (401, 403) else 4 if status in (408, 429) or status >= 500 else 5
        hint = ("Verify credentials and deployment access." if code == 3 else
                "Caller may retry with backoff; another call may incur charges." if code == 4 else
                "Check the deployment name and request against decide.py schema.")
        details = {"http_status": status}
        if retry_after.isdigit():
            details["retry_after_seconds"] = int(retry_after)
        raise DecisionError(code, f"Foundry returned HTTP {status}.", hint, **details) from exc
    except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.HTTPException) as exc:
        raise DecisionError(4, "Foundry request failed or timed out.",
                            "Check connectivity. Retrying may incur another charge.") from exc
    require(len(raw) <= MAX_RESPONSE, "Foundry response exceeds 1 MiB.", 5)
    try:
        payload = json.loads(raw, object_pairs_hook=unique_object, parse_constant=reject_constant)
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise DecisionError(5, "Foundry returned invalid JSON.", "Inspect the deployment; do not treat this as a decision.") from exc
    return payload, round((time.perf_counter() - start) * 1000, 1)


def normalize_response(payload, questions, threshold):
    require(isinstance(payload, dict) and text(payload.get("model")), "Response is missing model.", 5)
    answers = payload.get("answers")
    require(isinstance(answers, dict) and set(answers) == set(questions), "Response has missing or extra answers.", 5)
    normalized = {}
    for name, question in questions.items():
        answer = answers[name]
        kind = question["type"]
        require(isinstance(answer, dict) and answer.get("type") == kind, f"Invalid answer type for {name}.", 5)
        if kind == "noul":
            require(number(answer.get("noul"), 0, 1), f"Invalid noul probability for {name}.", 5)
            extra = {"value": answer["noul"] >= threshold, "threshold": threshold}
        else:
            criteria = question["criteria"]
            keys = set(criteria) if kind == "choice" else {str(i) for i in range(len(criteria))}
            probabilities = answer.get("probabilities")
            require(isinstance(probabilities, dict) and set(probabilities) == keys
                    and all(number(p, 0, 1) for p in probabilities.values())
                    and abs(sum(probabilities.values()) - 1) <= 0.02,
                    f"Invalid probability distribution for {name}.", 5)
            if kind == "choice":
                require(isinstance(answer.get("choice"), str) and answer["choice"] in criteria,
                        f"Unknown choice for {name}.", 5)
            else:
                require(number(answer.get("score"), 0, len(criteria) - 1), f"Score out of range for {name}.", 5)
            if "confidence" in answer:
                require(number(answer["confidence"], 0, 1), f"Invalid confidence for {name}.", 5)
            extra = {"value": answer[kind]}
        normalized[name] = {**answer, **extra}
    usage = payload.get("usage")
    require(isinstance(usage, dict) and all(type(usage.get(k)) is int and usage[k] >= 0
            for k in ("input_tokens", "output_tokens")), "Invalid token usage in response.", 5)
    return {"schema_version": 1, "model": payload["model"], "answers": normalized, "usage": usage}


def compact_answers(answers):
    return {
        name: {"value": answer["choice"], "probability": answer["probabilities"][answer["choice"]]}
        if answer["type"] == "choice" else answer["value"]
        for name, answer in answers.items()
    }


def schema():
    description = {"type": "string", "minLength": 1, "pattern": "\\S"}
    variants = []
    for kind, criteria in (
        ("noul", {"type": "object", "minProperties": 1, "additionalProperties": False,
                  "properties": {"true": description, "false": description}}),
        ("choice", {"type": "object", "minProperties": 2, "maxProperties": 255,
                    "propertyNames": description, "additionalProperties": description}),
        ("score", {"type": "array", "minItems": 2, "maxItems": 10,
                   "uniqueItems": True, "items": description}),
    ):
        variants.append({
            "type": "object", "additionalProperties": False,
            "required": ["type", "instructions"] + ([] if kind == "noul" else ["criteria"]),
            "properties": {"instructions": description, "type": {"const": kind}, "criteria": criteria},
        })
    probability = {"type": "number", "minimum": 0, "maximum": 1}
    probabilities = {"type": "object", "minProperties": 2, "additionalProperties": probability}
    score = {"type": "number", "minimum": 0, "maximum": 9,
             "description": "Probability-weighted level index, at most len(request criteria) - 1."}
    answer_variants = []
    for kind, fields, required in (
        ("noul", {"noul": probability, "threshold": probability, "value": {"type": "boolean"}},
         ["noul", "threshold"]),
        ("choice", {"choice": description, "probabilities": probabilities,
                    "confidence": probability, "value": description}, ["choice", "probabilities"]),
        ("score", {"score": score, "probabilities": probabilities, "confidence": probability,
                   "legend": {"type": "object", "additionalProperties": {"type": "string"}},
                   "value": score}, ["score", "probabilities"]),
    ):
        answer_variants.append({
            "type": "object", "required": ["type", "value", *required],
            "properties": {"type": {"const": kind}, **fields},
        })
    return {
        "schema_version": 2,
        "batch_input": {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object", "additionalProperties": False, "required": ["state", "questions"],
            "properties": {
                "state": {"oneOf": [description, {"type": "object", "minProperties": 1},
                                    {"type": "array", "minItems": 1}]},
                "questions": {"type": "object", "minProperties": 1, "maxProperties": 32,
                              "propertyNames": description, "additionalProperties": {"oneOf": variants}},
            },
        },
        "endpoint": "https://RESOURCE.services.ai.azure.com/providers/microsoft/v1/systemone",
        "setup": {"command": "setup", "endpoint_env": "DECIDE_ENDPOINT", "deployment_env": "DECIDE_DEPLOYMENT",
                  "non_interactive": "--non-interactive prevents first-use prompts; missing setup exits 3.",
                  "secret_input": "Hidden terminal prompt, macOS setup --key-stdin, or environment credentials."},
        "workflow": {"batch": "Combine independent questions sharing one state into one request.",
                     "chain": "Use prior answers as structured state only when the next stage depends on them.",
                     "branch": "Branch on answer values or probabilities, never on a successful exit code alone."},
        "limits": {"request_bytes": MAX_INPUT, "response_bytes": MAX_RESPONSE, "default_timeout_seconds": 30},
        "execution": {"max_api_attempts_per_decision": 1, "automatic_retries": False,
                      "validates_before_network": True,
                      "dry_run": "Validates and prints the request only; no API call or simulated response."},
        "output": "Default: named values, with {value, probability} for choices. Single-question commands use decision; "
                  "batch preserves question names. --full preserves the v1 envelope; --value emits a single scalar.",
        "output_schema": {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object", "minProperties": 1, "maxProperties": 32, "propertyNames": description,
            "additionalProperties": {"oneOf": [
                {"type": "boolean"}, score,
                {"type": "object", "additionalProperties": False, "required": ["value", "probability"],
                 "properties": {"value": description, "probability": probability}},
            ]},
        },
        "full_output_schema": {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object", "additionalProperties": False,
            "required": ["schema_version", "model", "answers", "usage", "latency_ms"],
            "properties": {
                "schema_version": {"const": 1},
                "model": description,
                "answers": {"type": "object", "minProperties": 1, "additionalProperties": {"oneOf": answer_variants}},
                "usage": {"type": "object", "required": ["input_tokens", "output_tokens"],
                          "properties": {"input_tokens": {"type": "integer", "minimum": 0},
                                         "output_tokens": {"type": "integer", "minimum": 0}}},
                "latency_ms": {"type": "number", "minimum": 0},
            },
        },
        "value_output_schema": {"oneOf": [{"type": "boolean"}, {"type": "string"}, {"type": "number"}]},
        "error_schema": {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object", "additionalProperties": False, "required": ["schema_version", "error"],
            "properties": {
                "schema_version": {"const": 1},
                "error": {
                    "type": "object", "required": ["exit_code", "message", "retryable"],
                    "properties": {
                        "exit_code": {"enum": [2, 3, 4, 5, 130]},
                        "message": description, "hint": description, "retryable": {"type": "boolean"},
                        "setup_required": {"type": "boolean"},
                        "http_status": {"type": "integer"},
                        "retry_after_seconds": {"type": "integer", "minimum": 0},
                    },
                },
            },
        },
        "exit_codes": EXIT_CODES,
    }


def parser():
    execution_help = "Input is validated before network access. At most one API attempt per decision; no automatic retries."
    root = Parser(description="Fast typed decisions. Minimal JSON stdout, JSON errors on stderr. Human-terminal setup on first use.",
                  epilog="Batch independent questions sharing state; chain dependent stages. "
                         f"{execution_help} Run schema for the contract. Python 3.10+, no packages.")
    commands = root.add_subparsers(dest="command", required=True, parser_class=Parser)
    commands.add_parser("schema", help="Print the local JSON contract; no auth or network.")
    setup = commands.add_parser("setup", help="Guide local configuration and hidden API-key entry; no API calls.")
    setup.add_argument("--endpoint", help="HTTPS Foundry resource URL, without project/API paths.")
    setup.add_argument("--deployment", help="Deployed model name (default: Decision-1).")
    setup.add_argument("--key-stdin", action="store_true", help="macOS: read the key from piped stdin, never an argument.")
    for name in ("noul", "choice", "score", "batch"):
        help_text = "One request for independent questions sharing state." if name == "batch" else f"Run {name} decisions."
        command = commands.add_parser(name, aliases=["bool"] if name == "noul" else [],
                                      help=help_text, epilog=execution_help)
        command.add_argument("--endpoint", help="Override the saved Foundry resource URL.")
        command.add_argument("--deployment", help="Override the saved deployment name.")
        command.add_argument("--non-interactive", action="store_true", help="Never prompt; missing setup exits 3 with guidance.")
        command.add_argument("--timeout", type=float, default=30, help="HTTP timeout, 0.1-120 seconds (default: 30).")
        command.add_argument("--threshold", type=float, default=0.5, help="Noul true threshold, inclusive (default: 0.5).")
        output = command.add_mutually_exclusive_group()
        output.add_argument("--value", action="store_true", help="Emit only the single JSON value, without probability or metadata.")
        output.add_argument("--full", action="store_true", help="Preserve the v1 response with all probabilities and metadata.")
        command.add_argument("--dry-run", action="store_true",
                             help="Validate and print the request only; no auth/network or simulated response.")
        if name == "batch":
            command.add_argument("--input", required=True, help="UTF-8 JSON file, or - for piped stdin.")
        else:
            command.add_argument("--question", required=True, help="A bounded question about the supplied state.")
            state = command.add_mutually_exclusive_group(required=True)
            state.add_argument("--state", help="Literal text, never interpreted as a path or JSON.")
            state.add_argument("--state-file", help="UTF-8 text file, or - for piped stdin.")
            if name == "noul":
                command.add_argument("--true", help="Describe the true condition.")
                command.add_argument("--false", help="Describe the false condition.")
            elif name == "choice":
                command.add_argument("--option", action="append", required=True, help="LABEL=description; repeat for each option.")
            else:
                command.add_argument("--level", action="append", required=True, help="Repeat levels in lowest-to-highest order.")
    return root


def main(argv=None):
    try:
        args = parser().parse_args(argv)
        if args.command == "schema":
            emit(schema())
            return 0
        if args.command == "setup":
            emit(run_setup(args))
            return 0
        body = request_from_args(args)
        config = load_config()
        body["model"] = setting(args, "deployment", config, "Decision-1")
        encode_request(body)
        if args.dry_run:
            emit(body)
            return 0
        try:
            endpoint = resource_endpoint(setting(args, "endpoint", config))
            headers = auth_headers(endpoint)
        except SetupRequired:
            if args.non_interactive or not human_terminal():
                raise
            run_setup(args)
            config = load_config()
            endpoint = resource_endpoint(setting(args, "endpoint", config))
            headers = auth_headers(endpoint)
            body["model"] = setting(args, "deployment", config, "Decision-1")
        payload, latency = call_api(body, args.timeout, endpoint, headers)
        result = normalize_response(payload, body["questions"], args.threshold)
        result["latency_ms"] = latency
        if args.value:
            emit(next(iter(result["answers"].values()))["value"])
        elif args.full:
            emit(result)
        else:
            emit(compact_answers(result["answers"]))
        return 0
    except DecisionError as exc:
        emit({"schema_version": 1, "error": {"exit_code": exc.code, **exc.error}}, sys.stderr)
        return exc.code
    except (KeyboardInterrupt, EOFError):
        emit({"schema_version": 1, "error": {"exit_code": 130, "message": "Cancelled.", "retryable": False}}, sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
