/** A usable timer delay. `0`, `Infinity` and values above setTimeout's limit mean "no limit". */
export function isDelay(ms: number): boolean {
  return ms > 0 && ms <= 0x7fff_ffff;
}
