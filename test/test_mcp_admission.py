"""Portable vectors plus Python boundary attacks; no transport or harness imports."""

import copy
from collections.abc import Mapping
import json
import os
from pathlib import Path
import sys
from types import MappingProxyType
import unittest

if not os.environ.get("HARBOR_TEST_INSTALLED"):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))
else:
    import harbor_llm

    assert (
        Path(harbor_llm.__file__).resolve().is_relative_to(Path(sys.prefix).resolve())
    )
from harbor_llm.mcp_admission import (
    McpAdmissionError,
    bind_mcp_servers_to_run,
    require_mcp_run_binding,
    parse_mcp_admission_policy,
)

CONTRACT = json.loads(
    (
        Path(__file__).resolve().parents[1]
        / "contracts"
        / "mcp-admission-conformance.v1.json"
    ).read_text()
)


class AdmissionTests(unittest.TestCase):
    def invoke(self, vector=None, **overrides):
        vector = vector or CONTRACT["cases"][0]
        server = {
            **CONTRACT["server"],
            **{k: vector[k] for k in ("connectionId", "url") if k in vector},
        }
        policy = copy.deepcopy(CONTRACT["policy"])
        if "gatewayUrl" in vector:
            policy["servers"]["fixture"]["gatewayUrl"] = vector["gatewayUrl"]
        return bind_mcp_servers_to_run(
            servers=[server],
            run_id=vector["runId"],
            execution_host_id=vector["executionHostId"],
            policy=policy,
            **overrides,
        )

    def test_portable_vectors(self):
        for vector in CONTRACT["cases"]:
            with self.subTest(vector=vector["name"]):
                if "expectedReason" in vector:
                    with self.assertRaises(McpAdmissionError) as caught:
                        self.invoke(vector)
                    self.assertEqual(caught.exception.reason, vector["expectedReason"])
                    self.assertEqual(
                        caught.exception.code, "runtime_mcp_admission_blocked"
                    )
                else:
                    self.assertEqual(
                        self.invoke(vector)[0]["runBinding"]["authorizedCrossHost"],
                        vector["expectedCrossHost"],
                    )

    def test_policy_array_and_boolean_types(self):
        for hosts in ("host-a", {"host-a": True}, ["host-a\n"], [], ["host-a"] * 65):
            policy = copy.deepcopy(CONTRACT["policy"])
            policy["servers"]["fixture"]["executionHostIds"] = hosts
            with (
                self.subTest(hosts=hosts),
                self.assertRaises(McpAdmissionError) as caught,
            ):
                bind_mcp_servers_to_run(
                    servers=[CONTRACT["server"]],
                    run_id="run-a",
                    execution_host_id="host-a",
                    policy=policy,
                )
            self.assertEqual(caught.exception.reason, "invalid_policy")
        policy = {**CONTRACT["policy"], "version": True}
        with self.assertRaises(McpAdmissionError):
            bind_mcp_servers_to_run(
                servers=[CONTRACT["server"]],
                run_id="run-a",
                execution_host_id="host-a",
                policy=policy,
            )

    def test_binding_is_frozen_and_rechecked(self):
        binding = self.invoke()[0]["runBinding"]
        expected = dict(
            run_id="run-a",
            execution_host_id="host-a",
            gateway_url=binding["gatewayUrl"],
        )
        checked = require_mcp_run_binding(binding, **expected)
        self.assertEqual(checked, binding)
        self.assertIsNot(checked, binding)
        with self.assertRaises(TypeError):
            binding["runId"] = "replacement"
        with self.assertRaises(TypeError):
            checked["runId"] = "replacement"
        for changes in (
            {"run_id": "old"},
            {"execution_host_id": "host-b"},
            {"gateway_url": "https://replacement.example"},
        ):
            with self.assertRaises(McpAdmissionError):
                require_mcp_run_binding(binding, **{**expected, **changes})
        for cross in (False, "true", 1, None):
            with self.assertRaises(McpAdmissionError):
                require_mcp_run_binding(
                    {**binding, "serverHostId": "host-b", "authorizedCrossHost": cross},
                    **expected,
                )

    def test_normalizer_redacts_callback_error(self):
        binding = self.invoke()[0]["runBinding"]

        def fail(_):
            raise RuntimeError("private-url-and-token")

        with self.assertRaises(McpAdmissionError) as caught:
            require_mcp_run_binding(
                binding,
                run_id="run-a",
                execution_host_id="host-a",
                gateway_url=binding["gatewayUrl"],
                normalize_recipient=fail,
            )
        self.assertNotIn("private", str(caught.exception))
        self.assertIsNone(caught.exception.__cause__)
        self.assertIsNone(caught.exception.__context__)

    def test_normalizer_results_never_compare_untrusted_objects(self):
        class PrivateResult:
            def __eq__(self, _):
                raise RuntimeError("private-normalizer-content")

        binding = self.invoke()[0]["runBinding"]
        for invalid_call in (1, 2):
            for result in (True, 1, "", None, PrivateResult()):
                calls = 0

                def normalize(_):
                    nonlocal calls
                    calls += 1
                    return result if calls == invalid_call else "same"

                with self.subTest(call=invalid_call, result=type(result)):
                    with self.assertRaises(McpAdmissionError) as caught:
                        require_mcp_run_binding(
                            binding,
                            run_id="run-a",
                            execution_host_id="host-a",
                            gateway_url=binding["gatewayUrl"],
                            normalize_recipient=normalize,
                        )
                    self.assertEqual(caught.exception.reason, "binding_mismatch")
                    self.assertIsNone(caught.exception.__context__)
                    self.assertNotIn("private", str(caught.exception))

    def test_policy_numeric_and_unicode_semantics(self):
        self.assertEqual(
            parse_mcp_admission_policy(json.loads('{"version":1.0,"servers":{}}')),
            {"version": 1, "servers": {}},
        )
        for url in ("\ud800", "😀" * 1025, "https://unused.example/é"):
            policy = copy.deepcopy(CONTRACT["policy"])
            policy["servers"]["unused"] = {**policy["servers"]["fixture"], "url": url}
            with (
                self.subTest(url=ascii(url)),
                self.assertRaises(McpAdmissionError) as caught,
            ):
                parse_mcp_admission_policy(policy)
            self.assertEqual(caught.exception.reason, "invalid_policy")

    def test_empty_delivery_and_stale_binding(self):
        self.assertEqual(
            bind_mcp_servers_to_run(servers=[], run_id="", policy=None), []
        )
        server = {
            **CONTRACT["server"],
            "runBinding": {"runId": "stale"},
            "token": "private",
        }
        bound = bind_mcp_servers_to_run(
            servers=[server],
            run_id="fresh",
            execution_host_id="host-a",
            policy=CONTRACT["policy"],
        )[0]
        self.assertEqual(bound["runBinding"]["runId"], "fresh")
        self.assertEqual(server["runBinding"]["runId"], "stale")

    def test_native_equality_is_never_an_admission_callback(self):
        class AlwaysEqual:
            def __eq__(self, _):
                return True

        class PrivateEquality:
            def __eq__(self, _):
                raise RuntimeError("private-comparison-marker")

        binding = self.invoke()[0]["runBinding"]
        expected = dict(
            run_id="run-a",
            execution_host_id="host-a",
            gateway_url=binding["gatewayUrl"],
        )
        for value in (AlwaysEqual(), PrivateEquality()):
            with self.subTest(value=type(value)):
                with self.assertRaises(McpAdmissionError) as caught:
                    bind_mcp_servers_to_run(
                        servers=[{**CONTRACT["server"], "url": value}],
                        run_id="run-a",
                        execution_host_id="host-a",
                        policy=CONTRACT["policy"],
                    )
                self.assertEqual(caught.exception.reason, "endpoint_mismatch")
                self.assertIsNone(caught.exception.__context__)
                for key in ("run_id", "execution_host_id"):
                    with self.assertRaises(McpAdmissionError) as caught:
                        require_mcp_run_binding(binding, **{**expected, key: value})
                    self.assertEqual(caught.exception.reason, "binding_mismatch")
                    self.assertIsNone(caught.exception.__context__)

    def test_mapping_proxy_reads_are_snapshotted_and_redacted(self):
        class TrapMapping(Mapping):
            def __iter__(self):
                raise RuntimeError("private-mapping-marker")

            def __len__(self):
                return 1

            def __getitem__(self, _):
                raise RuntimeError("private-mapping-marker")

        value = MappingProxyType(TrapMapping())
        calls = (
            (lambda: parse_mcp_admission_policy(value), "invalid_policy"),
            (
                lambda: require_mcp_run_binding(
                    value,
                    run_id="run-a",
                    execution_host_id="host-a",
                    gateway_url="https://worker.example/api",
                ),
                "binding_mismatch",
            ),
            (
                lambda: bind_mcp_servers_to_run(
                    servers=[value],
                    run_id="run-a",
                    execution_host_id="host-a",
                    policy=CONTRACT["policy"],
                ),
                "invalid_identity",
            ),
        )
        for call, reason in calls:
            with self.subTest(reason=reason):
                with self.assertRaises(McpAdmissionError) as caught:
                    call()
                self.assertEqual(caught.exception.reason, reason)
                self.assertNotIn("private", str(caught.exception))
                self.assertIsNone(caught.exception.__context__)
        backing = dict(self.invoke()[0]["runBinding"])
        checked = require_mcp_run_binding(
            MappingProxyType(backing),
            run_id="run-a",
            execution_host_id="host-a",
            gateway_url=backing["gatewayUrl"],
        )
        backing["runId"] = "replaced"
        self.assertEqual(checked["runId"], "run-a")


if __name__ == "__main__":
    unittest.main()
