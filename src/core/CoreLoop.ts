export class CoreLoop {
  private intervalId: ReturnType<typeof globalThis.setInterval> | null = null;
  private tickMs: number;

  constructor(private tickRateHz: number, private onTick: (dtMs: number) => void) {
    this.tickMs = 1000 / tickRateHz;
  }

  start(): void {
    if (this.intervalId !== null) return;
    this.intervalId = globalThis.setInterval(() => this.onTick(this.tickMs), this.tickMs);
  }

  stop(): void {
    if (this.intervalId !== null) {
      globalThis.clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}
