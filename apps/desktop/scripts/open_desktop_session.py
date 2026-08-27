#!/usr/bin/env python3
"""Open a Hermes Desktop chat via hermes:// deep link.

Requires the Desktop app to be installed (protocol handler registered) and
preferably already running.

Examples:
  python open_desktop_session.py
  python open_desktop_session.py --title MekAcc --cwd C:/Users/imba/git/infernos
  python open_desktop_session.py --prompt "Continue the noisium work" --listed 0
  python open_desktop_session.py --open SESSION_ID
"""

from __future__ import annotations

import argparse
import os
import sys
import webbrowser
from urllib.parse import quote, urlencode


def build_url(args: argparse.Namespace) -> str:
    if args.open:
        return f"hermes://session/open/{quote(args.open, safe='')}"

    q: dict[str, str] = {}
    if args.title:
        q["title"] = args.title
    if args.cwd:
        q["cwd"] = args.cwd
    if args.prompt:
        q["prompt"] = args.prompt
    if args.listed is not None and not args.listed:
        q["listed"] = "0"

    qs = urlencode(q)
    return f"hermes://session/new{('?' + qs) if qs else ''}"


def open_url(url: str) -> None:
    # Windows: os.startfile is more reliable for custom protocols than webbrowser
    if sys.platform == "win32":
        try:
            os.startfile(url)  # type: ignore[attr-defined]
            return
        except OSError:
            pass
    webbrowser.open(url)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--title", help="Session title")
    p.add_argument("--cwd", help="Workspace directory for the new session")
    p.add_argument("--prompt", help="Draft composer text (not auto-submitted)")
    p.add_argument(
        "--listed",
        type=int,
        choices=(0, 1),
        default=1,
        help="1 = show in sidebar (default), 0 = draft tab only",
    )
    p.add_argument("--open", metavar="SESSION_ID", help="Focus an existing stored session id")
    p.add_argument("--print-only", action="store_true", help="Print URL only, do not open")
    args = p.parse_args()
    url = build_url(args)
    print(url)
    if args.print_only:
        return 0
    open_url(url)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
