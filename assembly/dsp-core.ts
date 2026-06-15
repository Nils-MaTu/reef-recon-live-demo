let heapOffset: usize = 65536;

export function resetHeap(): void {
  heapOffset = 65536;
}

export function allocFloat32(count: i32): usize {
  const aligned = (heapOffset + 15) & ~15;
  heapOffset = aligned + (<usize>count << 2);
  return aligned;
}

export function clearFloat32(pointer: usize, count: i32): void {
  memory.fill(pointer, 0, <usize>count << 2);
}

// Each filter is a cascade of two biquads. Coefficients are stored as
// [b0, b1, b2, a1, a2] per section and state as [z1, z2] per section.
export function processCascadeBank(
  inputPointer: usize,
  outputPointer: usize,
  sampleCount: i32,
  filterCount: i32,
  coefficientPointer: usize,
  statePointer: usize,
): void {
  for (let filter = 0; filter < filterCount; filter += 1) {
    const coefficientBase = coefficientPointer + <usize>(filter * 10 << 2);
    const stateBase = statePointer + <usize>(filter * 4 << 2);
    const outputBase = outputPointer + <usize>(filter * sampleCount << 2);

    for (let sample = 0; sample < sampleCount; sample += 1) {
      let value = load<f32>(inputPointer + <usize>(sample << 2));

      for (let section = 0; section < 2; section += 1) {
        const coefficientOffset = coefficientBase + <usize>(section * 5 << 2);
        const stateOffset = stateBase + <usize>(section * 2 << 2);
        const b0 = load<f32>(coefficientOffset);
        const b1 = load<f32>(coefficientOffset + 4);
        const b2 = load<f32>(coefficientOffset + 8);
        const a1 = load<f32>(coefficientOffset + 12);
        const a2 = load<f32>(coefficientOffset + 16);
        const z1 = load<f32>(stateOffset);
        const z2 = load<f32>(stateOffset + 4);
        const output = b0 * value + z1;

        store<f32>(stateOffset, b1 * value - a1 * output + z2);
        store<f32>(stateOffset + 4, b2 * value - a2 * output);
        value = output;
      }

      store<f32>(outputBase + <usize>(sample << 2), value);
    }
  }
}

export function renderDetectorMix(
  controlledPointer: usize,
  acousticPointer: usize,
  acousticGainPointer: usize,
  acousticBandCount: i32,
  structuredPointer: usize,
  structuredGainPointer: usize,
  structuredBandCount: i32,
  outputPointer: usize,
  sampleCount: i32,
  suppressedGain: f32,
): void {
  for (let sample = 0; sample < sampleCount; sample += 1) {
    let bandSum: f32 = 0;
    let acousticMix: f32 = 0;

    for (let band = 0; band < acousticBandCount; band += 1) {
      const offset = <usize>((band * sampleCount + sample) << 2);
      const value = load<f32>(acousticPointer + offset);
      const gain = load<f32>(acousticGainPointer + offset);
      bandSum += value;
      acousticMix += value * gain;
    }

    let structuredDelta: f32 = 0;
    for (let band = 0; band < structuredBandCount; band += 1) {
      const offset = <usize>((band * sampleCount + sample) << 2);
      const value = load<f32>(structuredPointer + offset);
      const gain = load<f32>(structuredGainPointer + offset);
      structuredDelta += value * Mathf.max(gain - suppressedGain, 0);
    }

    const controlled = load<f32>(controlledPointer + <usize>(sample << 2));
    const residual = (controlled - bandSum) * suppressedGain;
    store<f32>(
      outputPointer + <usize>(sample << 2),
      residual + acousticMix + structuredDelta,
    );
  }
}

export function applyLimiter(
  inputPointer: usize,
  outputPointer: usize,
  sampleCount: i32,
  startGain: f32,
  endGain: f32,
  ceiling: f32,
): void {
  const denominator = Mathf.max(<f32>(sampleCount - 1), 1);
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const mix = <f32>sample / denominator;
    const gain = startGain + (endGain - startGain) * mix;
    const value = load<f32>(inputPointer + <usize>(sample << 2)) * gain;
    store<f32>(
      outputPointer + <usize>(sample << 2),
      Mathf.max(-ceiling, Mathf.min(ceiling, value)),
    );
  }
}
