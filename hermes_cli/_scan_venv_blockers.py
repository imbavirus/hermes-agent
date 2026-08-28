"""``hermes_cli/_scan_venv_blockers.py`` — Standalone venv-process scan for JSON consumption.

Invoked by the Desktop Electron app::

    venv\\Scripts\\python.exe -m hermes_cli._scan_venv_blockers

Exits 0 for valid clear or blocked results.  Non-zero exit signals probe
failure (the detector itself crashed, psutil unavailable, etc.).  Exactly
one JSON document on stdout; diagnostics on stderr only.
"""

from __future__ import annotations

import json
import math
import os
import re
import sys
from pathlib import PureWindowsPath
from typing import NoReturn

# Long CLI flags whose argument value must be redacted from the cmdline.
_SENSITIVE_LONG_FLAGS: list[str] = [
    "--token",
    "--api-key",
    "--password",
    "--secret",
    "--authorization",
    "--access-key",
    "--private-key",
    "--session-key",
]


def _probe_fail_json(diagnostic: str = "probe failed") -> str:
    """Return the standard probe-failure JSON document.

    ``ok: false`` plus ``probe_failed: true`` means the detector itself could
    not run — this is *not* a clear scan. Callers must treat
    ``ok is not True`` / non-zero exit as probe failure, never as
    ``blocked: false`` "clear" (#83149).
    """
    return json.dumps(
        {
            "ok": False,
            "probe_failed": True,
            "blocked": False,
            "processes": [],
            "error": diagnostic,
        }
    )


def _emit_probe_fail(diagnostic: str) -> NoReturn:
    """Print one JSON to stdout, diagnostic to stderr, exit non-zero."""
    print(_probe_fail_json(diagnostic))
    print(diagnostic, file=sys.stderr)
    sys.exit(1)


def _find_flag(text: str, flag: str) -> int:
    """Return the index of *flag* when it starts the string or follows a space.

    Returns -1 when not found.  This avoids matching ``--token`` inside an
    embedded token or path like ``/some--token-thing``.
    """
    low = text.lower()
    fl = flag.lower()
    pos = 0
    while True:
        idx = low.find(fl, pos)
        if idx == -1:
            return -1
        if idx == 0 or text[idx - 1] == " ":
            return idx
        pos = idx + 1


def _redact_sensitive_cmdline(cmdline: str) -> str:
    """Apply generic secret redaction then long-flag redaction.

    If the generic redactor itself fails, return ``"<redacted>"`` — the PID
    and process name still provide actionable diagnostics.
    """
    # Generic pass: the project's shared secret redactor.
    try:
        from agent.redact import redact_sensitive_text  # noqa: PLC0415

        cmdline = redact_sensitive_text(cmdline, force=True)
    except Exception:
        return "<redacted>"

    # Conservative long-flag pass: preserve the flag name, replace the value
    # and everything after it with ``<redacted>``.  Short flags (-t, -k, -p)
    # are intentionally not redacted — they are ambiguous and may be useful
    # diagnostics (toolset, port, profile).
    earliest = len(cmdline)
    for flag in _SENSITIVE_LONG_FLAGS:
        # --flag=value  →  preserve "--flag="
        idx = _find_flag(cmdline, flag + "=")
        if idx != -1 and idx + len(flag) + 1 < earliest:
            earliest = idx + len(flag) + 1
        # --flag value  →  preserve "--flag "
        idx = _find_flag(cmdline, flag + " ")
        if idx != -1 and idx + len(flag) + 1 < earliest:
            earliest = idx + len(flag) + 1

    if earliest < len(cmdline):
        return cmdline[:earliest] + "<redacted>"
    return cmdline


def _classify_local_preview_args(args: object) -> dict[str, object]:
    """Return safe UI metadata for an exact ``python -m http.server`` argv.

    The general holder detector intentionally truncates its diagnostic command
    line. Reading argv separately preserves a useful directory label without
    exposing an unbounded command line to the renderer.
    """
    if not isinstance(args, (list, tuple)) or not all(isinstance(arg, str) for arg in args):
        return {}

    # For a real interpreter module invocation, ``-m`` is the first argument
    # after the executable. A later ``-m http.server`` can merely be data passed
    # to an unrelated script and must never authorize termination.
    if len(args) < 3 or args[1] != "-m" or args[2].lower() != "http.server":
        return {}
    module_index = 1

    port = 8000
    if module_index + 2 < len(args):
        candidate = args[module_index + 2]
        if candidate.isdigit() and 0 < int(candidate) <= 65535:
            port = int(candidate)

    label = ""
    try:
        directory_index = args.index("--directory")
        if directory_index + 1 < len(args):
            label = PureWindowsPath(args[directory_index + 1]).name
    except ValueError:
        pass

    metadata: dict[str, object] = {
        "kind": "local-preview",
        "safeToStop": True,
        "port": port,
    }
    if label:
        metadata["label"] = label
    return metadata


def _local_preview_metadata(pid: int, name: str) -> dict[str, object]:
    if name.lower() not in {"python.exe", "pythonw.exe", "python", "pythonw"}:
        return {}
    try:
        import psutil  # noqa: PLC0415

        process = psutil.Process(pid)
        metadata = _classify_local_preview_args(process.cmdline())
        if metadata:
            metadata["createTime"] = process.create_time()
        return metadata
    except Exception:
        return {}


def _terminate_safe_preview(
    pid: int,
    expected_create_time: float,
    *,
    psutil_module: object | None = None,
) -> tuple[bool, str | None]:
    """Terminate one verified local preview process tree.

    A fresh ``psutil.Process`` identity check and exact argv classification occur
    immediately before termination. psutil guards mutating Process methods
    against PID reuse, avoiding taskkill's stale-PID race.
    """
    try:
        if psutil_module is None:
            import psutil as psutil_module  # type: ignore[no-redef]  # noqa: PLC0415

        process = psutil_module.Process(pid)  # type: ignore[attr-defined]
        if abs(process.create_time() - expected_create_time) > 0.001:
            return False, "process identity changed"
        if not _classify_local_preview_args(process.cmdline()):
            return False, "process is no longer a local preview"

        children = process.children(recursive=True)
        targets = [*reversed(children), process]
        for target in targets:
            target.terminate()
        _gone, alive = psutil_module.wait_procs(targets, timeout=3)  # type: ignore[attr-defined]
        for target in alive:
            target.kill()
        if alive:
            psutil_module.wait_procs(alive, timeout=2)  # type: ignore[attr-defined]
        return True, None
    except Exception as exc:
        return False, f"termination failed: {type(exc).__name__}"


def _is_pausable_gateway(cmdline: str) -> bool:
    """Return True when *cmdline* is a gateway process the updater can pause.

    A running gateway shows up in the venv-holder scan as one or both halves
    of its launcher/worker chain (``venv\\Scripts\\python.exe -m
    hermes_cli.main gateway run`` and the uv-side interpreter re-running the
    same argv). Reporting those as blockers dead-ends the Desktop update:
    the preflight aborts with ``venv-blocked`` *before* spawning
    ``hermes-setup``, so the CLI updater's own
    ``_pause_windows_gateways_for_update()`` — which exists precisely to
    stop these processes (and is always active: ``hermes-setup`` invokes
    ``hermes update --yes --gateway``) — never gets the chance to run.

    Only gateway invocations are exempted. Anything else running from the
    venv (an operator's REPL, a stray script, a ``serve`` backend that
    survived the desktop's own teardown) has no pause machinery downstream
    and must keep blocking the handoff.

    Delegates to ``gateway.status.looks_like_gateway_command_line`` — the
    canonical ``gateway run`` matcher (profile-selector aware, shlex
    tokenization, ``run``-only) — so this exemption, the pause discovery,
    and the updater's guard fallback all share one parser. A hand-rolled
    token scan here regressed ``--profile gateway gateway run``: the profile
    *value* shadowed the subcommand token. An import failure counts as
    not-pausable — the scan then reports the process as a blocker, which is
    exactly the pre-exemption behavior.
    """
    try:
        from gateway.status import looks_like_gateway_command_line  # noqa: PLC0415
    except Exception:
        return False
    return looks_like_gateway_command_line(cmdline)


def _process_parent_name(pid: int) -> str:
    """Best-effort parent image name (``services.exe`` / ``nssm.exe`` / …)."""
    try:
        import psutil  # noqa: PLC0415

        parent = psutil.Process(int(pid)).parent()
        return (parent.name() if parent else "") or ""
    except Exception:
        return ""


def _is_managed_service_process(cmdline: str, name: str = "", parent_name: str = "") -> bool:
    """True for NSSM/Windows-service venv pythons and profile/webui scripts.

    These are not user apps. ``hermes update`` has always run with them up.
    Listing them as 'close other processes' abort Apply is wrong — NSSM owns
    the python child; do not ask the user to kill services.exe workers.
    """
    parent = str(parent_name or "").lower()
    if parent in {"services.exe", "nssm.exe"}:
        return True
    blob = str(cmdline or "").replace("/", "\\").lower()
    if "hermes-webui" in blob and "server.py" in blob:
        return True
    if "\\profiles\\" in blob and "\\scripts\\" in blob:
        return True
    return False


def _classify_hermes_runtime_cmdline(cmdline: str, name: str = "") -> dict[str, object]:
    """Return safe-to-stop metadata for this-install Hermes CLI runtime holders.

    ``serve`` / leftover ``desktop --force-build`` / ``proxy`` hold
    ``venv\\Scripts\\hermes.exe`` on Windows and abort in-app Update after 15s.
    The venv shim process itself (name ``hermes.exe``) is always a holder,
    even when psutil cannot read its command line. Pausable python gateways
    stay empty so the existing exemption still applies.
    """
    if str(name).lower() in {"hermes.exe", "hermes"}:
        return {"kind": "hermes-runtime", "safeToStop": True}
    if not isinstance(cmdline, str) or not cmdline:
        return {}
    if _is_pausable_gateway(cmdline):
        return {}

    low = cmdline.lower()
    if "hermes_cli.main" in low:
        if "desktop --force-build" in low:
            return {"kind": "hermes-runtime", "safeToStop": True}
        if re.search(r"(?:^|\s)(?:serve|proxy)(?:\s|$)", low):
            return {"kind": "hermes-runtime", "safeToStop": True}
        return {}

    if re.search(r"hermes(?:\.exe)?[\"']?\s+desktop\s+--force-build", cmdline, re.I):
        return {"kind": "hermes-runtime", "safeToStop": True}
    if re.search(r"hermes(?:\.exe)?[\"']?\s+proxy\b", cmdline, re.I):
        return {"kind": "hermes-runtime", "safeToStop": True}
    if re.search(r"hermes(?:\.exe)?[\"']?\s+serve\b", cmdline, re.I):
        return {"kind": "hermes-runtime", "safeToStop": True}
    return {}


_PACK_DEBRIS_META = {"kind": "pack-debris", "safeToStop": True}
_PACK_DEBRIS_SKIP_NAMES = {
    "windowsterminal.exe",
    "openconsole.exe",
    "nssm.exe",
    "hermes.exe",
}


def _classify_pack_debris_cmdline(
    cmdline: str, name: str = "", cwd: str = ""
) -> dict[str, object]:
    """Leftover pack/update consoles: schtask cmd, npm/vite in this install.

    Users must not be left staring at an ``npm prefix`` window after update.
    Windows Terminal / nssm / the venv ``hermes.exe`` shim stay empty (shim
    is classified as hermes-runtime by name).
    """
    if str(name).lower() in _PACK_DEBRIS_SKIP_NAMES:
        return {}
    blob = f"{cmdline or ''} {cwd or ''}".replace("/", "\\").lower()
    if "rebuild-desktop-schtask.cmd" in blob:
        return dict(_PACK_DEBRIS_META)
    if "desktop --force-build" in blob:
        return dict(_PACK_DEBRIS_META)
    in_install = "hermes-agent" in blob or "apps\\desktop" in blob
    if not in_install:
        return {}
    if "electron-builder" in blob:
        return dict(_PACK_DEBRIS_META)
    if "npm-cli.js" in blob or re.search(r"\bnpm(?:\.cmd)?\b", blob):
        if re.search(r"\b(ci|install|run)\b", blob):
            return dict(_PACK_DEBRIS_META)
    return {}


def _iter_pack_debris_processes(existing_pids: set[int]):
    """Yield (pid, name, cmdline, meta) for leftover pack npm/cmd/node."""
    import psutil  # noqa: PLC0415

    for proc in psutil.process_iter(["pid", "name", "cmdline"]):
        try:
            pid = proc.info["pid"]
            if pid in existing_pids:
                continue
            name = proc.info.get("name") or ""
            cmd = " ".join(proc.info.get("cmdline") or [])
        except (psutil.Error, TypeError, OSError):
            continue
        meta = _classify_pack_debris_cmdline(cmd, name=name, cwd="")
        if not meta:
            try:
                cwd = proc.cwd()
            except (psutil.Error, OSError, TypeError):
                cwd = ""
            if cwd:
                meta = _classify_pack_debris_cmdline(cmd, name=name, cwd=cwd)
        if meta:
            yield pid, name, cmd, meta


def _is_shim_holder(cmdline: str, exe: str = "", shim_path: str = "") -> bool:
    """True when *exe* or *cmdline* is this install's ``venv\\Scripts\\hermes.exe``.

    uv trampolines run a python *outside* the venv whose argv is still the
    shim (xAI proxy). The Desktop ``win-unpacked\\Hermes.exe`` is a different
    path and must stay false. The ``--shim-holders`` scanner argv contains the
    shim path — do not match it or the scan kills itself.
    """
    if "--shim-holders" in str(cmdline or "").lower():
        return False
    needle = str(shim_path).replace("/", "\\").lower()
    if not needle:
        return False
    blob = f"{exe or ''} {cmdline or ''}".replace("/", "\\").lower()
    return needle in blob


def main() -> None:
    """Entry point.  Prints one JSON doc to stdout.  Exits 0 for valid scan."""
    try:
        import psutil  # noqa: PLC0415, F401
    except Exception as exc:
        _emit_probe_fail(f"psutil is not available: {exc}")

    try:
        from hermes_cli.main import _detect_venv_python_processes  # noqa: PLC0415

        matches = _detect_venv_python_processes()
    except Exception as exc:
        _emit_probe_fail(f"scan aborted: {exc}")

    processes = []
    for pid, name, cmdline in matches:
        if _is_pausable_gateway(cmdline):
            continue
        parent_name = _process_parent_name(pid)
        if _is_managed_service_process(cmdline, name=name, parent_name=parent_name):
            continue
        process = {
            "pid": pid,
            "name": name,
            # Truncate for display AFTER the gateway exemption has seen the
            # full cmdline (long managed-runtime interpreter paths would
            # otherwise swallow the `gateway run` argv).
            "cmdline": _redact_sensitive_cmdline(cmdline)[:120],
        }
        runtime_meta = _classify_hermes_runtime_cmdline(cmdline, name)
        if runtime_meta:
            process.update(runtime_meta)
        else:
            process.update(_local_preview_metadata(pid, name))
        processes.append(process)

    seen_pids = {int(p["pid"]) for p in processes}
    try:
        for pid, name, cmdline, meta in _iter_pack_debris_processes(seen_pids):
            processes.append(
                {
                    "pid": pid,
                    "name": name or "unknown",
                    "cmdline": _redact_sensitive_cmdline(cmdline)[:120],
                    **meta,
                }
            )
    except Exception:
        pass

    exempted = sum(1 for _pid, _name, cmdline in matches if _is_pausable_gateway(cmdline))
    data = {
        "ok": True,
        "blocked": bool(processes),
        "processes": processes,
        # Diagnostic only: gateway processes present but not counted as
        # blockers because the downstream updater pauses them itself.
        "pausable_gateways": exempted,
    }
    print(json.dumps(data))
    sys.exit(0)


def _terminate_safe_main(argv: list[str]) -> NoReturn:
    if len(argv) != 2:
        print(json.dumps({"ok": False, "error": "expected pid and create time"}))
        raise SystemExit(2)
    try:
        pid = int(argv[0])
        create_time = float(argv[1])
        if pid <= 0 or not math.isfinite(create_time) or create_time <= 0:
            raise ValueError
    except ValueError:
        print(json.dumps({"ok": False, "error": "invalid process identity"}))
        raise SystemExit(2)

    stopped, error = _terminate_safe_preview(pid, create_time)
    print(json.dumps({"ok": stopped, "pid": pid, "error": error}))
    raise SystemExit(0 if stopped else 1)


def _list_shim_holder_pids(shim_path: str) -> list[int]:
    """PIDs whose exe or cmdline is this install's venv hermes.exe shim."""
    import psutil  # noqa: PLC0415

    skip = {os.getpid()}
    try:
        skip.add(os.getppid())
    except OSError:
        pass
    pids: list[int] = []
    for proc in psutil.process_iter(["pid", "exe", "cmdline"]):
        try:
            pid = int(proc.info["pid"])
            if pid in skip:
                continue
            exe = proc.info.get("exe") or ""
            cmd = " ".join(proc.info.get("cmdline") or [])
        except (psutil.Error, TypeError, OSError, ValueError):
            continue
        if _is_shim_holder(cmd, exe=exe, shim_path=shim_path):
            pids.append(pid)
    return pids


def _shim_holders_main(argv: list[str]) -> NoReturn:
    if len(argv) != 1 or not argv[0]:
        print(json.dumps({"ok": False, "error": "expected shim path"}))
        raise SystemExit(2)
    try:
        import psutil  # noqa: PLC0415, F401
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"psutil is not available: {exc}"}))
        raise SystemExit(1)
    pids = _list_shim_holder_pids(argv[0])
    print(json.dumps({"ok": True, "pids": pids}))
    raise SystemExit(0)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--terminate-safe":
        _terminate_safe_main(sys.argv[2:])
    if len(sys.argv) > 1 and sys.argv[1] == "--shim-holders":
        _shim_holders_main(sys.argv[2:])
    main()