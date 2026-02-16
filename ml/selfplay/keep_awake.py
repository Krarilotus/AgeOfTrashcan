from __future__ import annotations

import ctypes
import sys
import threading
from typing import Optional


ES_SYSTEM_REQUIRED = 0x00000001
ES_DISPLAY_REQUIRED = 0x00000002
ES_CONTINUOUS = 0x80000000


class KeepAwakeGuard:
    def __init__(self, enabled: bool = True, interval_sec: float = 600.0) -> None:
        self.enabled = bool(enabled)
        self.interval_sec = max(30.0, float(interval_sec))
        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._active = False

    def start(self) -> None:
        if not self.enabled or self._active:
            return
        if sys.platform != "win32":
            print("[keep-awake] non-Windows platform detected; keep-awake no-op.")
            self._active = True
            return
        if not self._set_awake_state():
            print("[keep-awake] failed to set execution state; continuing without keep-awake.")
            self._active = True
            return
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        self._active = True
        print(f"[keep-awake] enabled (heartbeat every {self.interval_sec:.0f}s)")

    def stop(self) -> None:
        if not self._active:
            return
        self._stop_event.set()
        if self._thread is not None and self._thread.is_alive():
            self._thread.join(timeout=2.0)
        self._thread = None
        if sys.platform == "win32":
            self._clear_awake_state()
        self._active = False
        print("[keep-awake] disabled")

    def _run(self) -> None:
        while not self._stop_event.wait(self.interval_sec):
            if sys.platform == "win32":
                self._set_awake_state()

    def _set_awake_state(self) -> bool:
        state = ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED
        try:
            result = ctypes.windll.kernel32.SetThreadExecutionState(state)
        except Exception:
            return False
        return bool(result)

    def _clear_awake_state(self) -> None:
        try:
            ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS)
        except Exception:
            return

