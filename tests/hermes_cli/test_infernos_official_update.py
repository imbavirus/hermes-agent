"""Infernos fork is official; stale app.asar forces a desktop rebuild."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path
from unittest.mock import MagicMock

from hermes_cli import main as hm
from hermes_cli.update_cmd import (
    OFFICIAL_REPO_URL,
    _is_fork,
    _list_remote_urls,
    _resolve_update_remote,
)


def test_is_fork_treats_imbavirus_as_official():
    assert _is_fork("https://github.com/imbavirus/hermes-agent.git") is False
    assert _is_fork("https://github.com/imbavirus/hermes-agent") is False
    assert _is_fork("git@github.com:imbavirus/hermes-agent.git") is False
    assert _is_fork(OFFICIAL_REPO_URL) is False


def test_is_fork_treats_nous_as_not_official():
    assert _is_fork("https://github.com/NousResearch/hermes-agent.git") is True
    assert _is_fork("git@github.com:NousResearch/hermes-agent.git") is True
    assert _is_fork("https://github.com/example/hermes-agent.git") is True


def test_is_fork_none_is_not_a_fork():
    assert _is_fork(None) is False


def _fake_remote_v(mapping: dict[str, str]):
    def run(cmd, **_kwargs):
        joined = [str(c) for c in cmd]
        if "remote" in joined and "-v" in joined:
            lines = []
            for name, url in mapping.items():
                lines.append(f"{name}\t{url} (fetch)")
                lines.append(f"{name}\t{url} (push)")
            return subprocess.CompletedProcess(cmd, 0, stdout="\n".join(lines) + "\n", stderr="")
        if "remote" in joined and "add" in joined:
            mapping[joined[joined.index("add") + 1]] = joined[-1]
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
        raise AssertionError(f"unexpected git cmd: {cmd}")

    return run


def test_resolve_update_remote_prefers_origin_when_official():
    import hermes_cli.update_cmd as uc

    remotes = {"origin": "https://github.com/imbavirus/hermes-agent.git"}
    orig = uc.subprocess.run
    uc.subprocess.run = _fake_remote_v(remotes)
    try:
        assert _resolve_update_remote(["git"], Path(".")) == "origin"
    finally:
        uc.subprocess.run = orig


def test_resolve_update_remote_prefers_fork_when_origin_is_nous():
    import hermes_cli.update_cmd as uc

    remotes = {
        "origin": "https://github.com/NousResearch/hermes-agent.git",
        "fork": "git@github.com:imbavirus/hermes-agent.git",
    }
    orig = uc.subprocess.run
    uc.subprocess.run = _fake_remote_v(remotes)
    try:
        assert _resolve_update_remote(["git"], Path(".")) == "fork"
    finally:
        uc.subprocess.run = orig


def test_resolve_update_remote_adds_fork_when_origin_is_nous_only():
    import hermes_cli.update_cmd as uc

    remotes = {"origin": "https://github.com/NousResearch/hermes-agent.git"}
    orig = uc.subprocess.run
    uc.subprocess.run = _fake_remote_v(remotes)
    try:
        assert _resolve_update_remote(["git"], Path(".")) == "fork"
        assert remotes["fork"] == OFFICIAL_REPO_URL
    finally:
        uc.subprocess.run = orig


def test_list_remote_urls_keeps_fetch_url():
    import hermes_cli.update_cmd as uc

    orig = uc.subprocess.run
    remotes = {
        "origin": "https://github.com/NousResearch/hermes-agent.git",
        "fork": "git@github.com:imbavirus/hermes-agent.git",
    }
    uc.subprocess.run = _fake_remote_v(remotes)
    try:
        got = _list_remote_urls(["git"], Path("."))
        assert got["origin"] == remotes["origin"]
        assert got["fork"] == remotes["fork"]
    finally:
        uc.subprocess.run = orig


def test_packaged_asar_older_than_bots_plugin(tmp_path, monkeypatch):
    desktop_dir = tmp_path / "apps" / "desktop"
    exe = desktop_dir / "release" / "win-unpacked" / "Hermes.exe"
    asar = exe.parent / "resources" / "app.asar"
    plugin = tmp_path / "apps" / "desktop" / "src" / "plugins" / "hermes-bots" / "plugin.js"
    exe.parent.mkdir(parents=True)
    asar.parent.mkdir(parents=True)
    plugin.parent.mkdir(parents=True)
    exe.write_bytes(b"MZ")
    asar.write_bytes(b"asar")
    plugin.write_text("new plugin", encoding="utf-8")
    os.utime(asar, (1_000_000, 1_000_000))
    os.utime(plugin, (2_000_000, 2_000_000))

    monkeypatch.setattr(hm, "_desktop_packaged_executable", lambda _d: exe)
    assert hm._packaged_asar_older_than_source(desktop_dir, tmp_path) is True

    os.utime(asar, (3_000_000, 3_000_000))
    assert hm._packaged_asar_older_than_source(desktop_dir, tmp_path) is False


def test_desktop_build_needed_when_asar_stale(tmp_path, monkeypatch):
    desktop_dir = tmp_path / "apps" / "desktop"
    exe = desktop_dir / "release" / "win-unpacked" / "Hermes.exe"
    asar = exe.parent / "resources" / "app.asar"
    plugin = tmp_path / "apps" / "desktop" / "src" / "plugins" / "hermes-bots" / "plugin.js"
    exe.parent.mkdir(parents=True)
    asar.parent.mkdir(parents=True)
    plugin.parent.mkdir(parents=True)
    exe.write_bytes(b"MZ")
    asar.write_bytes(b"asar")
    plugin.write_text("new plugin", encoding="utf-8")
    os.utime(asar, (1_000_000, 1_000_000))
    os.utime(plugin, (2_000_000, 2_000_000))

    monkeypatch.setattr(hm, "_desktop_packaged_executable", lambda _d: exe)
    monkeypatch.setattr(hm, "_renderer_bundle_dir", lambda *_a, **_k: None)
    monkeypatch.setattr(hm, "_desktop_stamp_path", lambda: tmp_path / "missing-stamp.json")
    assert hm._desktop_build_needed(desktop_dir, tmp_path, source_mode=False) is True


def test_unlock_packaged_desktop_kills_hermes_exe(tmp_path, monkeypatch):
    from hermes_cli import update_cmd

    desktop_dir = tmp_path / "apps" / "desktop"
    exe = desktop_dir / "release" / "win-unpacked" / "Hermes.exe"
    exe.parent.mkdir(parents=True)
    exe.write_bytes(b"MZ")

    class _FakeMain:
        @staticmethod
        def _desktop_packaged_executable(_d):
            return exe

    monkeypatch.setattr(update_cmd, "_m", lambda: _FakeMain)
    monkeypatch.setattr(update_cmd.sys, "platform", "win32")
    calls = []

    def fake_run(cmd, **_kwargs):
        calls.append(cmd)
        return MagicMock(returncode=0)

    monkeypatch.setattr(update_cmd.subprocess, "run", fake_run)
    update_cmd._unlock_packaged_desktop_for_rebuild(desktop_dir)
    assert calls
    assert calls[0][:3] == ["taskkill", "/IM", "Hermes.exe"]


def test_asar_missing_infernos_bots_when_sentinel_only_in_source(tmp_path):
    asar = tmp_path / "app.asar"
    plugin = tmp_path / "plugin.js"
    plugin.write_bytes(b"function membersOwedMentionTurn(log, members) {}\n")
    asar.write_bytes(b"stock nous plugin without infernos chrome\n")
    assert hm._asar_missing_infernos_bots(asar, plugin) is True


def test_asar_missing_infernos_bots_false_when_packed(tmp_path):
    asar = tmp_path / "app.asar"
    plugin = tmp_path / "plugin.js"
    plugin.write_bytes(b"function membersOwedMentionTurn(log, members) {}\n")
    asar.write_bytes(b"xxxx membersOwedMentionTurn yyyy\n")
    assert hm._asar_missing_infernos_bots(asar, plugin) is False
