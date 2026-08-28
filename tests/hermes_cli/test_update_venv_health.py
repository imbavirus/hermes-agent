"""Tests for the Windows half-updated-venv hardening (July 2026 incident).

Covers three additions to ``hermes update``:

1. ``_venv_core_imports_healthy`` — the venv health probe that lets an
   "Already up to date" checkout still repair a broken dependency install.
2. ``_detect_venv_python_processes`` — the venv-interpreter process guard
   that refuses to mutate the venv while a desktop backend / stray python
   holds .pyd files mapped.
3. The commit_count == 0 repair branch wiring in ``_cmd_update_impl``.

All Windows-specific paths are exercised via ``_is_windows`` patching so
they run on any host (same approach as test_update_concurrent_quarantine).
"""

from __future__ import annotations

import subprocess
import sys
import types
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from hermes_cli import main as cli_main


# ---------------------------------------------------------------------------
# _venv_core_imports_healthy
# ---------------------------------------------------------------------------




def _fake_venv_python(tmp_path, *, windows: bool = False):
    bin_dir = tmp_path / "venv" / ("Scripts" if windows else "bin")
    bin_dir.mkdir(parents=True)
    py = bin_dir / ("python.exe" if windows else "python")
    py.write_bytes(b"")
    return py




# ---------------------------------------------------------------------------
# _detect_venv_python_processes
# ---------------------------------------------------------------------------


def _proc(
    pid: int,
    exe: str,
    name: str,
    cmdline: list[str] | None = None,
    cwd: str = "",
    parent_name: str = "",
):
    proc = MagicMock()
    proc.info = {
        "pid": pid,
        "exe": exe,
        "name": name,
        "cmdline": cmdline or [],
        "cwd": cwd,
    }
    if parent_name:
        parent = MagicMock()
        parent.name.return_value = parent_name
        proc.parent.return_value = parent
    else:
        proc.parent.return_value = None
    return proc




@patch.object(cli_main, "_is_windows", return_value=True)
def test_detect_venv_python_excludes_self_and_ancestors(_winp, tmp_path):
    import os as _os

    venv_py = str(tmp_path / "venv" / "Scripts" / "python.exe")
    parent = MagicMock()
    parent.pid = 555
    me = MagicMock()
    me.parents.return_value = [parent]
    fake_psutil = types.SimpleNamespace(
        process_iter=lambda attrs: iter(
            [
                _proc(_os.getpid(), venv_py, "python.exe"),
                _proc(555, venv_py, "hermes.exe"),
            ]
        ),
        Process=lambda *a, **k: me,
    )
    with patch.object(cli_main, "PROJECT_ROOT", tmp_path), patch.dict(
        sys.modules, {"psutil": fake_psutil}
    ):
        assert cli_main._detect_venv_python_processes() == []


@patch.object(cli_main, "_is_windows", return_value=True)
def test_detect_venv_python_skips_nssm_webui_profile_keeps_serve(_winp, tmp_path):
    """Unelevated Apply exit 2 listed NSSM/WebUI/profile pythons as venv holders.

    2026-08-28 20:11: ACCESS_DENIED skip worked, then ``hermes update`` died
    on PIDs 4856/19568/29392/30452/32032/35728 — the same services the
    overlay scanner already exempts. Overlay exemption is not the CLI guard.
    A live ``serve`` still blocks. A user REPL still blocks.
    """
    import os as _os

    venv_py = str(tmp_path / "venv" / "Scripts" / "python.exe")
    me = MagicMock()
    me.parents.return_value = []
    fake_psutil = types.SimpleNamespace(
        process_iter=lambda attrs: iter(
            [
                _proc(4856, venv_py, "python.exe", parent_name="services.exe"),
                _proc(19568, venv_py, "python.exe", parent_name="nssm.exe"),
                _proc(
                    29392,
                    venv_py,
                    "python.exe",
                    cmdline=[
                        venv_py,
                        "-u",
                        r"C:\Users\imba\hermes-webui\server.py",
                    ],
                    parent_name="nssm.exe",
                ),
                _proc(
                    30452,
                    venv_py,
                    "python.exe",
                    cmdline=[
                        venv_py,
                        r"C:\Users\imba\AppData\Local\hermes\profiles\dev\scripts\infernos-probe-mcp.py",
                    ],
                ),
                _proc(
                    32032,
                    venv_py,
                    "python.exe",
                    cmdline=[
                        venv_py,
                        r"C:\Users\imba\AppData\Local\hermes\profiles\dev\scripts\coolify-fail-chat.py",
                    ],
                ),
                _proc(35728, venv_py, "python.exe", parent_name="services.exe"),
                _proc(
                    999,
                    venv_py,
                    "python.exe",
                    cmdline=[venv_py, "-m", "hermes_cli.main", "serve"],
                ),
                _proc(
                    1001,
                    venv_py,
                    "python.exe",
                    cmdline=[venv_py],
                    parent_name="WindowsTerminal.exe",
                ),
            ]
        ),
        Process=lambda *a, **k: me,
    )
    with patch.object(cli_main, "PROJECT_ROOT", tmp_path), patch.dict(
        sys.modules, {"psutil": fake_psutil}
    ):
        matches = cli_main._detect_venv_python_processes()
    pids = [pid for pid, _name, _cmd in matches]
    assert 999 in pids
    assert 1001 in pids
    assert pids == [999, 1001]
    assert _os.getpid() not in pids




# ---------------------------------------------------------------------------
# --force vs --force-venv gating of the venv-holder guard
# ---------------------------------------------------------------------------


def _update_args(**overrides):
    defaults = dict(
        gateway=False,
        check=False,
        no_backup=True,
        backup=False,
        yes=True,
        branch=None,
        force=False,
        force_venv=False,
    )
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


def _run_update_until_guard(args):
    """Drive _cmd_update_impl just far enough to hit the venv-holder guard.

    Everything before the guard is stubbed; the guard firing is observed via
    SystemExit(2). The first statement AFTER the guard is
    ``git_dir = PROJECT_ROOT / ".git"`` — a PROJECT_ROOT sentinel whose
    ``__truediv__`` raises marks 'guard passed'."""

    class _PastGuard(Exception):
        pass

    class _RootSentinel:
        def __truediv__(self, _other):
            raise _PastGuard

    with patch.object(cli_main, "_is_windows", return_value=True), patch.object(
        cli_main, "_venv_scripts_dir", return_value=None
    ), patch.object(cli_main, "_run_pre_update_backup"), patch.object(
        cli_main, "_pause_windows_gateways_for_update", return_value=None
    ), patch.object(
        cli_main, "_resume_windows_gateways_after_update"
    ), patch.object(
        cli_main,
        "_detect_venv_python_processes",
        return_value=[(101, "python.exe", "python.exe -m hermes_cli.main serve")],
    ), patch.object(
        # Pin the orphan classifier: this test exercises --force/--force-venv
        # gating, not orphan detection (covered in
        # test_update_orphan_backend_reap.py). None = "not provably orphaned"
        # → the guard refuses exactly as before the orphan-reap addition.
        cli_main, "_orphaned_desktop_backend_pids", return_value=None
    ), patch.object(
        cli_main, "PROJECT_ROOT", _RootSentinel()
    ):
        try:
            cli_main._cmd_update_impl(args, gateway_mode=False)
        except _PastGuard:
            return "past_guard"
        except SystemExit as exc:
            return f"exit_{exc.code}"
    return "returned"


@pytest.mark.parametrize(
    "force,force_venv,expected",
    [
        (False, False, "exit_2"),   # guard fires
        (True, False, "exit_2"),    # plain --force does NOT bypass the venv guard
        (False, True, "past_guard"),  # --force-venv is the explicit escape hatch
        (True, True, "past_guard"),
    ],
)
def test_venv_holder_guard_force_semantics(force, force_venv, expected, capsys):
    result = _run_update_until_guard(_update_args(force=force, force_venv=force_venv))
    assert result == expected, capsys.readouterr().out
