// Small deterministic PRNG (mulberry32-like) for repeatable matches
export class PRNG {
  private state: number;

  constructor(seed: number) {
    // normalize seed to 32-bit unsigned
    this.state = seed >>> 0;
    if (this.state === 0) this.state = 1;
  }

  // Returns float in [0,1)
  next(): number {
    let t = (this.state += 0x6d2b79f5) >>> 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    this.state = t >>> 0;
    return r;
  }

  nextInt(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
}
