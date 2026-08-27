"""Windows SCM service that starts the gateway as the logged-on user.

Hard rule: Hermes never persists via VBS / wscript / the Startup folder.
Boot persistence is a LocalSystem service that waits for an interactive
session, then ``CreateProcessAsUser``s the console ``python.exe`` gateway
(CREATE_NO_WINDOW). The gateway itself always runs as the user.

The service executable is a generated ``*_svc.py`` trampoline next to
``*.scm.json`` (written by ``gateway_windows._write_task_script``).
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

# ---------------------------------------------------------------------------
# Spec I/O (no pywin32 required — used by install + tests)
# ---------------------------------------------------------------------------

_SPEC_VERSION = 1
_WAIT_SESSION_S = 2.0
_WAIT_CHILD_S = 2.0
_CHILD_RESTART_S = 5.0


def spec_path_for_host(host_path: Path) -> Path:
    """``Hermes_Gateway_dev_svc.py`` → ``Hermes_Gateway_dev.scm.json``."""
    name = host_path.name
    if name.lower().endswith("_svc.py"):
        return host_path.with_name(name[: -len("_svc.py")] + ".scm.json")
    return host_path.with_name("scm.json")


def load_spec(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"scm spec is not an object: {path}")
    argv = data.get("argv")
    if not isinstance(argv, list) or not argv:
        raise ValueError(f"scm spec missing argv: {path}")
    if any(not isinstance(x, str) for x in argv):
        raise ValueError(f"scm spec argv must be strings: {path}")
    return data


def dump_spec(path: Path, spec: dict) -> None:
    payload = {"version": _SPEC_VERSION, **spec}
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8", newline="\n")
    tmp.replace(path)


def render_scm_host(repo_root: str) -> str:
    """Tiny trampoline so SCM can start us without a pre-set PYTHONPATH."""
    repo = json.dumps(str(repo_root))
    return (
        "import sys\n"
        "from pathlib import Path\n"
        f"sys.path.insert(0, {repo})\n"
        "from hermes_cli.windows_gateway_svc import main\n"
        "if __name__ == '__main__':\n"
        "    raise SystemExit(main())\n"
    )


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------

def _spec_from_argv() -> Path:
    if os.environ.get("HERMES_SCM_SPEC"):
        return Path(os.environ["HERMES_SCM_SPEC"])
    argv0 = Path(sys.argv[0]).resolve() if sys.argv and sys.argv[0] else Path.cwd()
    return spec_path_for_host(argv0)


def _quote_cmd(argv: list[str]) -> str:
    import subprocess

    return subprocess.list2cmdline(argv)


def _wait_for_console_session(stop_check, timeout_chunk: float = _WAIT_SESSION_S) -> int | None:
    import win32ts

    while not stop_check():
        session_id = int(win32ts.WTSGetActiveConsoleSessionId())
        if session_id not in (0, 0xFFFFFFFF):
            return session_id
        # Session 0 is services. 0xFFFFFFFF is "no session".
        if session_id == 0:
            # Some consoles report 1+ once a user is attached; keep waiting.
            pass
        time.sleep(timeout_chunk)
    return None


def _spawn_as_logged_on_user(spec: dict, session_id: int) -> int:
    """CreateProcessAsUser the gateway. Returns PID."""
    import win32con
    import win32process
    import win32profile
    import win32ts

    token = win32ts.WTSQueryUserToken(session_id)
    env = win32profile.CreateEnvironmentBlock(token, False)
    overlay = spec.get("env") or {}
    if isinstance(overlay, dict):
        for key, value in overlay.items():
            if isinstance(key, str) and isinstance(value, str):
                env[key] = value

    argv = list(spec["argv"])
    cwd = spec.get("cwd") or None
    cmdline = _quote_cmd(argv)

    si = win32process.STARTUPINFO()
    si.dwFlags |= win32con.STARTF_USESHOWWINDOW
    si.wShowWindow = win32con.SW_HIDE

    flags = (
        win32con.CREATE_NO_WINDOW
        | win32con.CREATE_UNICODE_ENVIRONMENT
        | win32con.CREATE_NEW_PROCESS_GROUP
    )
    _handle, _thread, pid, _tid = win32process.CreateProcessAsUser(
        token,
        None,
        cmdline,
        None,
        None,
        0,
        flags,
        env,
        cwd,
        si,
    )
    return int(pid)


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        import ctypes

        SYNCHRONIZE = 0x00100000
        handle = ctypes.windll.kernel32.OpenProcess(SYNCHRONIZE, False, pid)
        if handle:
            ctypes.windll.kernel32.CloseHandle(handle)
            return True
    except Exception:
        pass
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _request_child_stop(pid: int) -> None:
    try:
        from gateway.status import write_planned_stop_marker

        write_planned_stop_marker(pid)
    except Exception:
        pass


class HermesUserSessionService:
    """SCM service: spawn the user-session process described by scm.json."""

    _svc_name_ = "Hermes_Gateway"
    _svc_display_name_ = "Hermes Agent Gateway"
    _svc_description_ = "Starts the Hermes messaging gateway in the logged-on user session."

    def __init__(self, args=None):
        import win32event
        import win32serviceutil

        win32serviceutil.ServiceFramework.__init__(self, args)
        self._stop = win32event.CreateEvent(None, 0, 0, None)
        self._child_pid = 0

    def SvcStop(self):
        import win32event
        import win32service

        self.ReportServiceStatus(win32service.SERVICE_STOP_PENDING)
        if self._child_pid:
            _request_child_stop(self._child_pid)
        win32event.SetEvent(self._stop)

    def SvcDoRun(self):
        import servicemanager
        import win32event
        import win32service

        spec_path = _spec_from_argv()
        try:
            spec = load_spec(spec_path)
        except Exception as exc:
            servicemanager.LogErrorMsg(f"Hermes SCM spec unreadable ({spec_path}): {exc}")
            return

        self.ReportServiceStatus(win32service.SERVICE_RUNNING)
        servicemanager.LogInfoMsg(f"Hermes service running; spec={spec_path}")

        while win32event.WaitForSingleObject(self._stop, 0) != win32event.WAIT_OBJECT_0:
            session_id = _wait_for_console_session(
                lambda: win32event.WaitForSingleObject(self._stop, 0) == win32event.WAIT_OBJECT_0
            )
            if session_id is None:
                break
            try:
                pid = _spawn_as_logged_on_user(spec, session_id)
            except Exception as exc:
                servicemanager.LogErrorMsg(f"Hermes CreateProcessAsUser failed: {exc}")
                if win32event.WaitForSingleObject(self._stop, int(_CHILD_RESTART_S * 1000)) == win32event.WAIT_OBJECT_0:
                    break
                continue
            self._child_pid = pid
            servicemanager.LogInfoMsg(f"Hermes user process started pid={pid} session={session_id}")
            while _pid_alive(pid):
                if win32event.WaitForSingleObject(self._stop, int(_WAIT_CHILD_S * 1000)) == win32event.WAIT_OBJECT_0:
                    _request_child_stop(pid)
                    # Give the planned-stop marker a moment, then exit the loop.
                    deadline = time.monotonic() + 8.0
                    while _pid_alive(pid) and time.monotonic() < deadline:
                        time.sleep(0.4)
                    return
            self._child_pid = 0
            if win32event.WaitForSingleObject(self._stop, int(_CHILD_RESTART_S * 1000)) == win32event.WAIT_OBJECT_0:
                break


def _service_class(spec: dict | None = None):
    import win32serviceutil

    class _Svc(HermesUserSessionService, win32serviceutil.ServiceFramework):
        pass

    if spec:
        name = spec.get("service_name")
        display = spec.get("display_name")
        desc = spec.get("description")
        if isinstance(name, str) and name:
            _Svc._svc_name_ = name
        if isinstance(display, str) and display:
            _Svc._svc_display_name_ = display
        if isinstance(desc, str) and desc:
            _Svc._svc_description_ = desc
    return _Svc


def main(argv: list[str] | None = None) -> int:
    """SCM entry (no args) or ``install/remove/start/stop`` via pywin32."""
    args = list(sys.argv[1:] if argv is None else argv)
    try:
        spec = load_spec(_spec_from_argv())
    except Exception:
        spec = {}
    cls = _service_class(spec)

    if not args:
        import servicemanager
        import win32serviceutil

        servicemanager.Initialize()
        servicemanager.PrepareToHostSingle(cls)
        servicemanager.StartServiceCtrlDispatcher()
        return 0

    import win32serviceutil

    # HandleCommandLine reads sys.argv
    saved = sys.argv[:]
    try:
        sys.argv = [sys.argv[0], *args]
        win32serviceutil.HandleCommandLine(cls)
    finally:
        sys.argv = saved
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
