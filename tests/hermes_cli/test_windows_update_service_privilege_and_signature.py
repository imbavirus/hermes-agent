"""Regression tests for the two Windows updater defects that took the whole gateway fleet down.

1. ``_wait_for_gateway_ready`` lost ``all_profiles`` / ``home``, so every
   ``update_cmd_windows.py`` call site raised ``TypeError`` — on the normal
   post-update success path, not only on rollback. Three helpers the updater
   calls (``_live_gateway_pids``, ``_write_start_attestation``,
   ``_consume_start_attestation``) were missing from ``gateway_windows.py``
   entirely, so even the code paths that did import could not run.

2. A service the updater is not privileged to stop (``sc.exe`` →
   ``OpenService FAILED 5``) aborted the entire update instead of degrading to
   plain-process mode.

The signature test is the load-bearing one: every pre-existing test mocks
``_wait_for_gateway_ready`` with ``lambda **_kw``, which accepts any keyword and
therefore can never catch a caller/definition drift. ``inspect.signature``
compares the real definitions against the real call sites.
"""

from __future__ import annotations

import ast
import inspect
from pathlib import Path

import pytest

from hermes_cli import gateway_windows
from hermes_cli import update_cmd_windows

_UPDATE_WINDOWS = Path(update_cmd_windows.__file__)


# ---------------------------------------------------------------------------
# 1. the signature / missing-helper contract
# ---------------------------------------------------------------------------


def test_wait_for_gateway_ready_accepts_every_kwarg_the_updater_passes():
    """The defect, stated as a contract: every kwarg any call site uses must exist.

    Without this the drift ships silently, because the existing suites all stub the
    function out with ``lambda **_kw``.
    """
    params = inspect.signature(gateway_windows._wait_for_gateway_ready).parameters
    for kwarg in ("timeout_s", "interval_s", "confirm_s", "all_profiles", "home"):
        assert kwarg in params, f"_wait_for_gateway_ready lost its {kwarg!r} parameter"


def _await_ready_kwargs_in_source() -> list[dict]:
    """Every ``_wait_for_gateway_ready(...)`` keyword call in the updater source."""
    tree = ast.parse(_UPDATE_WINDOWS.read_text(encoding="utf-8"))
    found: list[dict] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        name = func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", None)
        if name != "_wait_for_gateway_ready":
            continue
        found.append({kw.arg: kw.value for kw in node.keywords if kw.arg})
    return found


def test_every_await_ready_call_site_kwargs_are_real():
    """Bind each call site's keywords against the real signature — the check that would have
    caught ``all_profiles=`` and ``home=`` on their way in."""
    signature = inspect.signature(gateway_windows._wait_for_gateway_ready)
    if any(p.kind is inspect.Parameter.VAR_KEYWORD for p in signature.parameters.values()):
        return
    for kwargs in _await_ready_kwargs_in_source():
        # Only keywords are asserted: positional arity at these call sites is 0, and
        # ``signature.bind`` with a placeholder would fail on an unrelated positional mismatch.
        signature.bind_partial(**kwargs)


@pytest.mark.parametrize(
    "symbol",
    ["_live_gateway_pids", "_consume_start_attestation", "_write_start_attestation",
     "check_start_attestation", "attested_death_generation", "_hermes_home"],
)
def test_updater_calls_symbols_that_actually_exist(symbol):
    """``AttributeError: has no attribute`` killed the resume path; assert the surface exists."""
    assert hasattr(gateway_windows, symbol), f"gateway_windows.{symbol} is missing"


def test_pause_call_sites_bind_against_real_signatures():
    """Every ``gateway_windows.<helper>(...)`` the updater makes must bind against the real
    definition. ``_live_gateway_pids(home=...)`` / ``_spawn_detached(home=...)`` were the
    latent landmines here."""
    tree = ast.parse(_UPDATE_WINDOWS.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if not (isinstance(func, ast.Attribute) and getattr(func.value, "id", None) == "gateway_windows"):
            continue
        symbol = func.attr
        if not hasattr(gateway_windows, symbol):
            continue
        target = getattr(gateway_windows, symbol)
        if not callable(target):
            continue
        try:
            signature = inspect.signature(target)
        except (TypeError, ValueError):
            continue
        if any(p.kind is inspect.Parameter.VAR_KEYWORD for p in signature.parameters.values()):
            continue
        kwargs = {kw.arg: kw.value for kw in node.keywords if kw.arg}
        # Keywords only: these call sites' positional arity varies per helper, and a
        # placeholder would fail on an unrelated positional mismatch instead of the kwarg drift.
        signature.bind_partial(**kwargs)


# ---------------------------------------------------------------------------
# 2. the service-stop must degrade, not abort
# ---------------------------------------------------------------------------


class _Service:
    def __init__(self, name="Hermes_Gateway_devops"):
        self.name = name
        self.profile = "devops"
        self.service_pid = 100
        self.service_create_time = 1.0
        self.gateway_pid = 200
        self.gateway_create_time = 2.0
        self.descendant_identities = ()


@pytest.mark.parametrize(
    "message",
    [
        "[SC] OpenService FAILED 5: Access is denied.",
        "[SC] Access is denied.",
        "privilege not held",
    ],
)
def test_access_denied_is_recognised_as_a_privilege_problem(message):
    assert update_cmd_windows._is_service_access_denied(RuntimeError(message))


@pytest.mark.parametrize(
    "message",
    [
        "Windows service Hermes_Gateway_devops did not stop within 30s; venv mutation unsafe.",
        "Windows service X stopped but its process tree is still alive: [123]",
        "Windows gateway is no longer owned by service X",
    ],
)
def test_real_stop_failures_still_fail_closed(message):
    """Degrading must be narrow: a service that refused to stop still locks the venv, so the
    update must NOT continue as if the pause succeeded."""
    assert not update_cmd_windows._is_service_access_denied(RuntimeError(message))


def test_unprivileged_service_is_skipped_not_fatal(monkeypatch, capsys):
    """The whole point: one un-stoppable service must not abort the fleet-wide update."""
    import hermes_cli.update_cmd as update_cmd

    def _refuse(name, **_kwargs):
        raise RuntimeError("[SC] OpenService FAILED 5: Access is denied.")

    monkeypatch.setattr(update_cmd, "_stop_windows_gateway_service", _refuse)
    monkeypatch.setattr(update_cmd, "_restore_windows_gateway_service", lambda name: None)
    monkeypatch.setattr(
        update_cmd_windows, "_is_windows", lambda: True, raising=False
    )

    token = {"resume_needed": True, "profiles": {}, "unmapped_pids": [], "unmapped": []}
    result = update_cmd_windows._pause_windows_gateway_services(
        [_Service()], token, {}, []
    )

    # survived, and the skipped service is reported but NOT queued for resume
    assert result["skipped_services"] == ["Hermes_Gateway_devops"]
    assert not (result.get("services") or []), "a service we never stopped must not be resumed"
    assert "Hermes_Gateway_devops" in capsys.readouterr().out


def test_privileged_service_is_still_recorded_for_resume(monkeypatch):
    """The fail-soft path must not swallow the normal case: a service we DID stop has to come back."""
    import hermes_cli.update_cmd as update_cmd

    stopped = []
    monkeypatch.setattr(
        update_cmd, "_stop_windows_gateway_service", lambda name, **_kw: stopped.append(name)
    )
    monkeypatch.setattr(update_cmd, "_restore_windows_gateway_service", lambda name: None)

    token = {"resume_needed": True, "profiles": {}, "unmapped_pids": [], "unmapped": []}
    result = update_cmd_windows._pause_windows_gateway_services(
        [_Service("Hermes_Gateway_social")], token, {}, []
    )

    assert stopped == ["Hermes_Gateway_social"]
    assert result["services"] == ["Hermes_Gateway_social"]
    assert not result.get("skipped_services")


def test_real_stop_failure_still_triggers_rollback(monkeypatch):
    """A non-privilege failure must roll the already-paused services back, as before."""
    import hermes_cli.update_cmd as update_cmd

    calls = {"stop": 0}

    def _stop(name, **_kwargs):
        calls["stop"] += 1
        if calls["stop"] == 1:
            return None
        raise RuntimeError("Windows service X did not stop within 30s; venv mutation unsafe.")

    restored = []
    monkeypatch.setattr(update_cmd, "_stop_windows_gateway_service", _stop)
    monkeypatch.setattr(
        update_cmd, "_restore_windows_gateway_service", lambda name: restored.append(name)
    )

    token = {"resume_needed": True, "profiles": {}, "unmapped_pids": [], "unmapped": []}
    with pytest.raises(RuntimeError):
        update_cmd_windows._pause_windows_gateway_services(
            [_Service("A"), _Service("B")], token, {}, []
        )
    # Rollback covers the in-flight service AND the one already paused, newest first.
    assert restored == ["B", "A"]