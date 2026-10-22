# SPDX-License-Identifier: MIT — see src/mcp-admission.LICENSE.
"""Semantic admission for Python consumers of Harbor's version-1 MCP contract.

Bindings are immutable metadata, never authenticated grants or credentials.
"""

import ipaddress
import json
import re
from importlib.resources import files
from types import MappingProxyType
from urllib.parse import urlsplit


def contract(name):
    """Read an installed, versioned contract asset (no consumer-owned copies)."""
    if name not in (
        "mcp-admission-policy.v1.schema.json",
        "mcp-run-binding.v1.schema.json",
        "mcp-admission-conformance.v1.json",
    ):
        raise ValueError("Unknown MCP contract asset")
    return json.loads(files("harbor_llm").joinpath("contracts", name).read_text())


_policy_schema = contract("mcp-admission-policy.v1.schema.json")
_server_schema = _policy_schema["properties"]["servers"]["additionalProperties"][
    "properties"
]
_identifier = re.compile(
    _policy_schema["properties"]["servers"]["propertyNames"]["pattern"]
)
MCP_ADMISSION_LIMITS = MappingProxyType(
    {
        "serversPerRun": 8,
        "executionHostsPerServer": _server_schema["executionHostIds"]["maxItems"],
        "identifierCharacters": 128,
        "endpointCharacters": _server_schema["url"]["maxLength"],
        "policyBytes": 64 * 1024,
    }
)
_remedies = {
    "invalid_identity": "Select an explicit run and execution identity.",
    "invalid_policy": "Provide a bounded version-1 operator-owned endpoint and host policy.",
    "too_many_servers": "Reduce the admitted server set to the per-run limit.",
    "duplicate_server": "Resolve each connection exactly once.",
    "server_not_authorized": "Ask the operator to authorize the exact resolved connection.",
    "endpoint_mismatch": "Resolve a fresh connection matching the operator-approved endpoint.",
    "execution_host_not_authorized": "Ask the operator to authorize the selected execution host.",
    "unsafe_endpoint": "Use an exact HTTPS or loopback HTTP endpoint without credentials, query or fragment.",
    "binding_mismatch": "Resolve fresh admission for this run, execution host and credential recipient.",
}


class McpAdmissionError(ValueError):
    code = "runtime_mcp_admission_blocked"

    def __init__(self, reason):
        self.reason = reason
        super().__init__(f"Runtime MCP admission blocked. {_remedies[reason]}")


def is_mcp_admission_identifier(value):
    return type(value) is str and _identifier.fullmatch(value) is not None


def _record(value):
    return type(value) in (dict, MappingProxyType)


def _data_record(value, reason, required=(), optional=(), *, extensions=False):
    """Snapshot dictionary/proxy reads; never retain caller-owned mappings."""
    failed, result = False, {}
    try:
        if not _record(value):
            raise ValueError()
        for key in value:
            if type(key) is not str:
                raise ValueError()
            result[key] = value[key]
        if not set(required) <= set(result) or (
            not extensions and not set(result) <= set(required) | set(optional)
        ):
            raise ValueError()
    except Exception:
        failed = True
    if failed:
        raise McpAdmissionError(reason)
    return result


def _endpoint_string(value):
    return (
        type(value) is str
        and 0 < len(value) <= MCP_ADMISSION_LIMITS["endpointCharacters"]
        and value.isascii()
    )


def _safe_endpoint(value):
    if (
        type(value) is not str
        or not 0 < len(value) <= MCP_ADMISSION_LIMITS["endpointCharacters"]
        or re.search(r"[^\x21-\x7e]", value)
    ):
        return False
    authority = re.fullmatch(
        r"https?://(\[[0-9a-f:.]+\]|[a-z0-9_.-]+)(?::[0-9]+)?(?:/[^?#\\]*)?",
        value,
        re.I,
    )
    if authority is None:
        return False
    if authority[1].endswith(".."):
        return False
    try:
        url = urlsplit(value)
        _ = url.port
        if (
            url.scheme not in ("https", "http")
            or not url.hostname
            or url.username is not None
            or url.password is not None
            or url.query
            or url.fragment
            or "\\" in value
        ):
            return False
        if authority[1].startswith("["):
            ipaddress.IPv6Address(url.hostname)
        else:
            last_label = url.hostname.removesuffix(".").rsplit(".", 1)[-1]
            if re.fullmatch(r"[0-9]+|0x[0-9a-f]*", last_label, re.I):
                ipaddress.IPv4Address(url.hostname)
        if url.scheme == "https":
            return True
        return url.hostname in ("localhost", "127.0.0.1") or (
            ":" in url.hostname
            and ipaddress.IPv6Address(url.hostname) == ipaddress.IPv6Address("::1")
        )
    except (ValueError, TypeError):
        return False


def require_mcp_credential_endpoint(value):
    if not _safe_endpoint(value):
        raise McpAdmissionError("unsafe_endpoint")
    return value


def parse_mcp_admission_policy(policy):
    policy = _data_record(policy, "invalid_policy", ("version", "servers"))
    if type(policy["version"]) not in (int, float) or policy["version"] != 1:
        raise McpAdmissionError("invalid_policy")
    servers = {}
    entries = _data_record(policy["servers"], "invalid_policy", extensions=True)
    for identifier, value in entries.items():
        entry = _data_record(
            value,
            "invalid_policy",
            ("url", "gatewayUrl", "serverHostId", "executionHostIds"),
        )
        if (
            not is_mcp_admission_identifier(identifier)
            or not all(_endpoint_string(entry[key]) for key in ("url", "gatewayUrl"))
            or not is_mcp_admission_identifier(entry["serverHostId"])
            or type(entry["executionHostIds"]) is not list
            or not 1
            <= len(entry["executionHostIds"])
            <= MCP_ADMISSION_LIMITS["executionHostsPerServer"]
            or not all(
                is_mcp_admission_identifier(host) for host in entry["executionHostIds"]
            )
        ):
            raise McpAdmissionError("invalid_policy")
        servers[identifier] = {
            "url": entry["url"],
            "gatewayUrl": entry["gatewayUrl"],
            "serverHostId": entry["serverHostId"],
            "executionHostIds": list(entry["executionHostIds"]),
        }
    parsed = {"version": 1, "servers": servers}
    # All validated values are ASCII. Compact JSON escaping matches ESM exactly.
    if (
        len(json.dumps(parsed, ensure_ascii=False, separators=(",", ":")).encode())
        > MCP_ADMISSION_LIMITS["policyBytes"]
    ):
        raise McpAdmissionError("invalid_policy")
    return parsed


def bind_mcp_servers_to_run(*, servers, run_id, execution_host_id=None, policy=None):
    if type(servers) is not list:
        raise McpAdmissionError("invalid_policy")
    if not servers:
        return []
    if len(servers) > MCP_ADMISSION_LIMITS["serversPerRun"]:
        raise McpAdmissionError("too_many_servers")
    if not is_mcp_admission_identifier(run_id) or not is_mcp_admission_identifier(
        execution_host_id
    ):
        raise McpAdmissionError("invalid_identity")
    approved = parse_mcp_admission_policy(policy)["servers"]
    result, seen = [], set()
    for value in servers:
        server = _data_record(value, "invalid_identity", extensions=True)
        if not is_mcp_admission_identifier(server.get("connectionId")):
            raise McpAdmissionError("invalid_identity")
        identifier = server["connectionId"]
        if identifier in seen:
            raise McpAdmissionError("duplicate_server")
        seen.add(identifier)
        if identifier not in approved:
            raise McpAdmissionError("server_not_authorized")
        entry = approved[identifier]
        if type(server.get("url")) is not str or entry["url"] != server["url"]:
            raise McpAdmissionError("endpoint_mismatch")
        if execution_host_id not in entry["executionHostIds"]:
            raise McpAdmissionError("execution_host_not_authorized")
        require_mcp_credential_endpoint(entry["url"])
        require_mcp_credential_endpoint(entry["gatewayUrl"])
        result.append(
            {
                **server,
                "runBinding": MappingProxyType(
                    {
                        "runId": run_id,
                        "executionHostId": execution_host_id,
                        "serverHostId": entry["serverHostId"],
                        "gatewayUrl": entry["gatewayUrl"],
                        "authorizedCrossHost": entry["serverHostId"]
                        != execution_host_id,
                    }
                ),
            }
        )
    return result


def require_mcp_run_binding(
    binding, *, run_id, execution_host_id, gateway_url, normalize_recipient=None
):
    binding = _data_record(
        binding,
        "binding_mismatch",
        ("runId", "executionHostId", "serverHostId", "gatewayUrl"),
        ("authorizedCrossHost",),
    )
    if (
        not all(
            is_mcp_admission_identifier(value) for value in (run_id, execution_host_id)
        )
        or not all(
            is_mcp_admission_identifier(binding[key])
            for key in ("runId", "executionHostId", "serverHostId")
        )
        or binding["runId"] != run_id
        or binding["executionHostId"] != execution_host_id
        or (
            "authorizedCrossHost" in binding
            and type(binding["authorizedCrossHost"]) is not bool
        )
        or (
            binding["serverHostId"] != execution_host_id
            and binding.get("authorizedCrossHost") is not True
        )
    ):
        raise McpAdmissionError("binding_mismatch")
    approved = require_mcp_credential_endpoint(binding["gatewayUrl"])
    actual, failed = require_mcp_credential_endpoint(gateway_url), False
    if normalize_recipient is not None:
        try:
            approved, actual = (
                normalize_recipient(approved),
                normalize_recipient(actual),
            )
        except Exception:
            failed = True
    # Raise outside the except suite so callback text is absent even from __context__.
    if (
        failed
        or type(approved) is not str
        or type(actual) is not str
        or not approved
        or not actual
        or approved != actual
    ):
        raise McpAdmissionError("binding_mismatch")
    return MappingProxyType(binding)
