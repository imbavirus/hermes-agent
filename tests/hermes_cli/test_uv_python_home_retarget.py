"""Win11 untrusted uv python junctions: retarget pyvenv.cfg home=."""

from __future__ import annotations

from pathlib import Path

from hermes_cli._install_repair import retarget_broken_uv_python_home


def _uv_layout(tmp_path: Path) -> tuple[Path, Path, Path]:
    uv_python = tmp_path / "AppData" / "Roaming" / "uv" / "python"
    unversioned = uv_python / "cpython-3.11-windows-x86_64-none"
    versioned = uv_python / "cpython-3.11.15-windows-x86_64-none"
    unversioned.mkdir(parents=True)
    versioned.mkdir(parents=True)
    (versioned / "python.exe").write_bytes(b"MZ")
    venv = tmp_path / "hermes-agent" / "venv"
    venv.mkdir(parents=True)
    (venv / "pyvenv.cfg").write_text(
        f"home = {unversioned}\nimplementation = CPython\nuv = 0.12.3\nversion_info = 3.11\n",
        encoding="utf-8",
    )
    return venv, unversioned, versioned


def test_retarget_rewrites_home_when_unversioned_python_missing(tmp_path):
    venv, _unversioned, versioned = _uv_layout(tmp_path)
    new_home = retarget_broken_uv_python_home(venv)
    assert new_home == str(versioned)
    home_line = [
        ln
        for ln in (venv / "pyvenv.cfg").read_text(encoding="utf-8").splitlines()
        if ln.strip().lower().startswith("home")
    ][0]
    assert "cpython-3.11.15-windows-x86_64-none" in home_line


def test_retarget_noop_when_home_python_exists(tmp_path):
    venv, unversioned, _versioned = _uv_layout(tmp_path)
    (unversioned / "python.exe").write_bytes(b"MZ")
    assert retarget_broken_uv_python_home(venv) is None
    assert str(unversioned) in (venv / "pyvenv.cfg").read_text(encoding="utf-8")


def test_retarget_noop_when_already_versioned(tmp_path):
    venv, _unversioned, versioned = _uv_layout(tmp_path)
    (venv / "pyvenv.cfg").write_text(
        f"home = {versioned}\nversion_info = 3.11\n",
        encoding="utf-8",
    )
    assert retarget_broken_uv_python_home(venv) is None
