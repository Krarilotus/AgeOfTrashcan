export class CoreLoop {
  private intervalId: number | null = null;
  private tickMs: number;

  constructor(private tickRateHz: number, private onTick: (dtMs: number) => void) {
    this.tickMs = 1000 / tickRateHz;
  }

  start(): void {
    if (this.intervalId !== null) return;
    this.intervalId = window.setInterval(() => this.onTick(this.tickMs), this.tickMs);
  }

  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}
