from __future__ import annotations

from collections import deque
from dataclasses import dataclass
import subprocess
import threading
import time
from typing import Deque, Optional, Tuple

import psutil
import torch


@dataclass(slots=True)
class ResourceSample:
    timestamp: float
    cpu_percent: float
    ram_percent: float
    gpu_util_percent: Optional[float]
    gpu_mem_percent: Optional[float]
    gpu_source: Optional[str]


class ResourceMonitor:
    def __init__(
        self,
        sample_hz: float = 10.0,
        gpu_probe_hz: float = 2.0,
        enable_gpu: bool = True,
        cuda_device_index: int = 0,
        history_sec: float = 30.0,
    ) -> None:
        self.sample_hz = max(0.5, float(sample_hz))
        self.gpu_probe_hz = max(0.2, float(gpu_probe_hz))
        self.enable_gpu = bool(enable_gpu)
        self.cuda_device_index = max(0, int(cuda_device_index))
        self.history_sec = max(5.0, float(history_sec))
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._latest: Optional[ResourceSample] = None
        self._history: Deque[ResourceSample] = deque()
        self._cached_gpu: Tuple[Optional[float], Optional[float]] = (None, None)
        self._next_gpu_probe = 0.0

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        psutil.cpu_percent(interval=None)
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=1.5)
        self._thread = None

    def latest(self) -> Optional[ResourceSample]:
        with self._lock:
            return self._latest

    def averaged(self, window_sec: float = 1.0) -> Optional[ResourceSample]:
        window = max(0.2, float(window_sec))
        with self._lock:
            if not self._history:
                return None
            now = self._history[-1].timestamp
            cutoff = now - window
            samples = [sample for sample in self._history if sample.timestamp >= cutoff]
            if not samples:
                return self._history[-1]

        cpu = float(sum(sample.cpu_percent for sample in samples) / len(samples))
        ram = float(sum(sample.ram_percent for sample in samples) / len(samples))
        gpu_util_values = [sample.gpu_util_percent for sample in samples if sample.gpu_util_percent is not None]
        gpu_mem_values = [sample.gpu_mem_percent for sample in samples if sample.gpu_mem_percent is not None]
        gpu_util = (
            float(sum(gpu_util_values) / len(gpu_util_values))
            if gpu_util_values
            else None
        )
        gpu_mem = (
            float(sum(gpu_mem_values) / len(gpu_mem_values))
            if gpu_mem_values
            else None
        )
        gpu_source = next(
            (sample.gpu_source for sample in reversed(samples) if sample.gpu_source),
            None,
        )
        return ResourceSample(
            timestamp=now,
            cpu_percent=cpu,
            ram_percent=ram,
            gpu_util_percent=gpu_util,
            gpu_mem_percent=gpu_mem,
            gpu_source=gpu_source,
        )

    def sustained_gpu_util_over(
        self,
        threshold_percent: float,
        window_sec: float = 10.0,
        min_ratio: float = 0.9,
    ) -> bool:
        window = max(1.0, float(window_sec))
        ratio_needed = min(1.0, max(0.1, float(min_ratio)))
        with self._lock:
            if not self._history:
                return False
            now = self._history[-1].timestamp
            cutoff = now - window
            samples = [
                sample for sample in self._history
                if sample.timestamp >= cutoff and sample.gpu_util_percent is not None
            ]
            if len(samples) < 2:
                return False
            # Ensure we actually have near-full coverage for this window.
            covered = samples[-1].timestamp - samples[0].timestamp
            if covered < (window * 0.9):
                return False

        over_count = sum(
            1
            for sample in samples
            if float(sample.gpu_util_percent or 0.0) >= float(threshold_percent)
        )
        return (over_count / max(1, len(samples))) >= ratio_needed

    def _run(self) -> None:
        interval = 1.0 / self.sample_hz
        while not self._stop.is_set():
            now = time.perf_counter()
            cpu = float(psutil.cpu_percent(interval=None))
            ram = float(psutil.virtual_memory().percent)
            gpu_util, gpu_mem = self._cached_gpu
            if self.enable_gpu and now >= self._next_gpu_probe:
                gpu_util, gpu_mem = self._query_gpu_percentages()
                self._cached_gpu = (gpu_util, gpu_mem)
                self._next_gpu_probe = now + (1.0 / self.gpu_probe_hz)
            sample = ResourceSample(
                timestamp=now,
                cpu_percent=cpu,
                ram_percent=ram,
                gpu_util_percent=gpu_util,
                gpu_mem_percent=gpu_mem,
                gpu_source="nvidia-smi" if gpu_util is not None else None,
            )
            with self._lock:
                self._latest = sample
                self._history.append(sample)
                while self._history and (now - self._history[0].timestamp) > self.history_sec:
                    self._history.popleft()
            self._stop.wait(interval)

    def _query_gpu_percentages(self) -> Tuple[Optional[float], Optional[float]]:
        if not self.enable_gpu or not torch.cuda.is_available():
            return None, None
        cmd = [
            "nvidia-smi",
            "--query-gpu=index,utilization.gpu,memory.used,memory.total",
            "--format=csv,noheader,nounits",
        ]
        try:
            result = subprocess.run(
                cmd,
                check=True,
                capture_output=True,
                text=True,
                timeout=1.0,
            )
        except Exception:
            return None, None
        for line in result.stdout.splitlines():
            parts = [part.strip() for part in line.split(",")]
            if len(parts) < 4:
                continue
            try:
                index = int(parts[0])
            except ValueError:
                continue
            if index != self.cuda_device_index:
                continue
            try:
                gpu_util = float(parts[1])
                mem_used = float(parts[2])
                mem_total = float(parts[3])
            except ValueError:
                return None, None
            mem_pct = (mem_used / max(1.0, mem_total)) * 100.0
            return gpu_util, mem_pct
        return None, None
