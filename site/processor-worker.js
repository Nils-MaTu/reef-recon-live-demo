import { DEMO_CONFIG } from "./config.js";

const EPSILON = 1e-12;
const FFT_SIZE = 512;
const IDENTITY = [1, 0, 0, 0, 0];
let sourceSamples = null;
let sourceSampleRate = DEMO_CONFIG.sampleRate;
let latestRequest = 0;
let kernelPromise = null;

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function dbToGain(db) {
  return 10 ** (db / 20);
}

function gainToDb(gain) {
  return 20 * Math.log10(Math.max(gain, EPSILON));
}

function alphaForMs(milliseconds, frameRate) {
  if (milliseconds <= 0) {
    return 0;
  }
  return Math.exp(-1 / ((milliseconds / 1000) * frameRate));
}

function smoothGain(current, target, attackAlpha, releaseAlpha) {
  const alpha = target < current ? attackAlpha : releaseAlpha;
  return alpha * current + (1 - alpha) * target;
}

function compressorGain(inputRms, thresholdRms, ratio) {
  if (inputRms <= thresholdRms || inputRms <= EPSILON) {
    return 1;
  }
  return (inputRms / Math.max(thresholdRms, EPSILON)) ** (1 / ratio - 1);
}

function meanSquare(values, count = values.length) {
  let sum = 0;
  for (let index = 0; index < count; index += 1) {
    sum += values[index] * values[index];
  }
  return sum / Math.max(count, 1);
}

function peakAbsolute(values, count = values.length) {
  let peak = 0;
  for (let index = 0; index < count; index += 1) {
    peak = Math.max(peak, Math.abs(values[index]));
  }
  return peak;
}

function normalizeBiquad(b0, b1, b2, a0, a1, a2) {
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

function lowpass(frequency, sampleRate, q = Math.SQRT1_2) {
  const omega = (2 * Math.PI * frequency) / sampleRate;
  const cosine = Math.cos(omega);
  const alpha = Math.sin(omega) / (2 * q);
  return normalizeBiquad(
    (1 - cosine) / 2,
    1 - cosine,
    (1 - cosine) / 2,
    1 + alpha,
    -2 * cosine,
    1 - alpha,
  );
}

function highpass(frequency, sampleRate, q = Math.SQRT1_2) {
  const omega = (2 * Math.PI * frequency) / sampleRate;
  const cosine = Math.cos(omega);
  const alpha = Math.sin(omega) / (2 * q);
  return normalizeBiquad(
    (1 + cosine) / 2,
    -(1 + cosine),
    (1 + cosine) / 2,
    1 + alpha,
    -2 * cosine,
    1 - alpha,
  );
}

function highShelf(frequency, sampleRate, gainDb) {
  const amplitude = 10 ** (gainDb / 40);
  const omega = (2 * Math.PI * frequency) / sampleRate;
  const cosine = Math.cos(omega);
  const sine = Math.sin(omega);
  const alpha = (sine / 2) * Math.sqrt(2);
  const root = 2 * Math.sqrt(amplitude) * alpha;
  return normalizeBiquad(
    amplitude * ((amplitude + 1) + (amplitude - 1) * cosine + root),
    -2 * amplitude * ((amplitude - 1) + (amplitude + 1) * cosine),
    amplitude * ((amplitude + 1) + (amplitude - 1) * cosine - root),
    (amplitude + 1) - (amplitude - 1) * cosine + root,
    2 * ((amplitude - 1) - (amplitude + 1) * cosine),
    (amplitude + 1) - (amplitude - 1) * cosine - root,
  );
}

function bandpass(lowHz, highHz, sampleRate) {
  return [highpass(lowHz, sampleRate), lowpass(highHz, sampleRate)];
}

function fourthOrderHighpass(frequency, sampleRate) {
  return [
    highpass(frequency, sampleRate, 0.5411961),
    highpass(frequency, sampleRate, 1.306563),
  ];
}

class WasmKernel {
  constructor(instance, sampleRate) {
    this.exports = instance.exports;
    this.memory = this.exports.memory;
    this.exports.resetHeap();
    this.inputPointer = this.allocate(DEMO_CONFIG.blockSize);
    this.controlledPointer = this.allocate(DEMO_CONFIG.blockSize);
    this.renderPointer = this.allocate(DEMO_CONFIG.blockSize);
    this.limitedPointer = this.allocate(DEMO_CONFIG.blockSize);
    this.acousticGainPointer = this.allocate(3 * DEMO_CONFIG.blockSize);
    this.structuredGainPointer = this.allocate(4 * DEMO_CONFIG.blockSize);

    this.whitening = this.createBank([
      [highShelf(1200, sampleRate, 4), IDENTITY],
    ]);
    this.agc = this.createBank([bandpass(100, 1500, sampleRate)]);
    this.split = this.createBank([
      bandpass(50, 150, sampleRate),
      bandpass(150, 1000, sampleRate),
      fourthOrderHighpass(1000, sampleRate),
    ]);
    this.acoustic = this.createBank([
      bandpass(150, 300, sampleRate),
      bandpass(300, 600, sampleRate),
      bandpass(600, 1000, sampleRate),
    ]);
    this.structured = this.createBank([
      bandpass(1000, 1600, sampleRate),
      bandpass(1600, 2500, sampleRate),
      bandpass(2500, 4000, sampleRate),
      bandpass(4000, 6300, sampleRate),
    ]);
  }

  allocate(count) {
    return this.exports.allocFloat32(count);
  }

  view(pointer, count) {
    return new Float32Array(this.memory.buffer, pointer, count);
  }

  createBank(filters) {
    const coefficients = new Float32Array(filters.length * 10);
    filters.forEach((sections, filterIndex) => {
      sections.forEach((section, sectionIndex) => {
        coefficients.set(section, filterIndex * 10 + sectionIndex * 5);
      });
    });
    const coefficientPointer = this.allocate(coefficients.length);
    const statePointer = this.allocate(filters.length * 4);
    const outputPointer = this.allocate(filters.length * DEMO_CONFIG.blockSize);
    this.view(coefficientPointer, coefficients.length).set(coefficients);
    this.exports.clearFloat32(statePointer, filters.length * 4);
    return {
      count: filters.length,
      coefficientPointer,
      statePointer,
      outputPointer,
    };
  }

  resetState() {
    for (const bank of [
      this.whitening,
      this.agc,
      this.split,
      this.acoustic,
      this.structured,
    ]) {
      this.exports.clearFloat32(bank.statePointer, bank.count * 4);
    }
  }

  processBank(input, count, bank) {
    this.view(this.inputPointer, count).set(input.subarray(0, count));
    this.exports.processCascadeBank(
      this.inputPointer,
      bank.outputPointer,
      count,
      bank.count,
      bank.coefficientPointer,
      bank.statePointer,
    );
    return this.view(bank.outputPointer, bank.count * count);
  }

  band(output, bandIndex, count) {
    return output.subarray(bandIndex * count, (bandIndex + 1) * count);
  }

  render(controlled, acousticGains, structuredGains, count, suppressedGain) {
    this.view(this.controlledPointer, count).set(controlled.subarray(0, count));
    this.view(this.acousticGainPointer, acousticGains.length).set(acousticGains);
    this.view(this.structuredGainPointer, structuredGains.length).set(
      structuredGains,
    );
    this.exports.renderDetectorMix(
      this.controlledPointer,
      this.acoustic.outputPointer,
      this.acousticGainPointer,
      this.acoustic.count,
      this.structured.outputPointer,
      this.structuredGainPointer,
      this.structured.count,
      this.renderPointer,
      count,
      suppressedGain,
    );
    return this.view(this.renderPointer, count);
  }

  limit(input, count, startGain, endGain, ceiling) {
    this.view(this.renderPointer, count).set(input.subarray(0, count));
    this.exports.applyLimiter(
      this.renderPointer,
      this.limitedPointer,
      count,
      startGain,
      endGain,
      ceiling,
    );
    return this.view(this.limitedPointer, count);
  }
}

async function createKernel(sampleRate) {
  const wasmUrl = new URL("./dsp-core.wasm", self.location.href);
  const response = await fetch(wasmUrl);
  if (!response.ok) {
    throw new Error(`Could not load WebAssembly core (${response.status})`);
  }
  const bytes = await response.arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes, {
    env: { abort: () => { throw new Error("WebAssembly aborted"); } },
  });
  return new WasmKernel(instance, sampleRate);
}

function updateEnergyCompressor(state, values, count, frameRate, settings) {
  const energy = meanSquare(values, count) + EPSILON;
  if (state.shortEnergy <= 0 || state.longEnergy <= 0) {
    state.shortEnergy = energy;
    state.longEnergy = energy;
  } else {
    const shortAlpha = alphaForMs(settings.shortMs, frameRate);
    const longAlpha = alphaForMs(settings.longMs, frameRate);
    state.shortEnergy =
      shortAlpha * state.shortEnergy + (1 - shortAlpha) * energy;
    state.longEnergy =
      longAlpha * state.longEnergy + (1 - longAlpha) * energy;
  }
  const target = compressorGain(
    Math.sqrt(state.shortEnergy),
    Math.sqrt(state.longEnergy) * dbToGain(settings.thresholdDb),
    settings.ratio,
  );
  state.gain = smoothGain(
    state.gain,
    target,
    alphaForMs(settings.attackMs, frameRate),
    alphaForMs(settings.releaseMs, frameRate),
  );
}

function applySuppressionMapping(dynamicGain, suppressionDb, nominalDb) {
  if (suppressionDb <= 0) {
    return 1;
  }
  const wet = clamp(suppressionDb / nominalDb, 0, 2.5);
  return Math.max(
    dbToGain(-suppressionDb),
    1 + wet * (dynamicGain - 1),
  );
}

function fftPower(input) {
  const real = new Float64Array(FFT_SIZE);
  const imaginary = new Float64Array(FFT_SIZE);
  for (let index = 0; index < FFT_SIZE; index += 1) {
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (FFT_SIZE - 1));
    real[index] = input[index] * window;
  }

  let j = 0;
  for (let index = 1; index < FFT_SIZE; index += 1) {
    let bit = FFT_SIZE >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (index < j) {
      [real[index], real[j]] = [real[j], real[index]];
    }
  }

  for (let length = 2; length <= FFT_SIZE; length <<= 1) {
    const angle = (-2 * Math.PI) / length;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let start = 0; start < FFT_SIZE; start += length) {
      let twiddleReal = 1;
      let twiddleImaginary = 0;
      for (let offset = 0; offset < length / 2; offset += 1) {
        const even = start + offset;
        const odd = even + length / 2;
        const oddReal =
          real[odd] * twiddleReal - imaginary[odd] * twiddleImaginary;
        const oddImaginary =
          real[odd] * twiddleImaginary + imaginary[odd] * twiddleReal;
        real[odd] = real[even] - oddReal;
        imaginary[odd] = imaginary[even] - oddImaginary;
        real[even] += oddReal;
        imaginary[even] += oddImaginary;
        const nextReal =
          twiddleReal * stepReal - twiddleImaginary * stepImaginary;
        twiddleImaginary =
          twiddleReal * stepImaginary + twiddleImaginary * stepReal;
        twiddleReal = nextReal;
      }
    }
  }

  const power = new Float64Array(FFT_SIZE / 2 + 1);
  for (let index = 0; index < power.length; index += 1) {
    power[index] = real[index] ** 2 + imaginary[index] ** 2;
  }
  return power;
}

function localMedian(values, index, radius) {
  const start = Math.max(0, index - radius);
  const end = Math.min(values.length, index + radius + 1);
  const window = Array.from(values.subarray(start, end)).sort((a, b) => a - b);
  return window[Math.floor(window.length / 2)];
}

function structuredDetection(window, sampleRate, prominenceDb) {
  const gains = new Float32Array(4);
  const levelDbfs = 10 * Math.log10(meanSquare(window) + EPSILON);
  if (levelDbfs < -70) {
    return { flag: false, gains };
  }

  const power = fftPower(window);
  const firstBin = Math.max(1, Math.ceil((100 * FFT_SIZE) / sampleRate));
  const lastBin = Math.min(
    power.length - 2,
    Math.floor((10000 * FFT_SIZE) / sampleRate),
  );
  const bandPower = power.subarray(firstBin, lastBin + 1);
  const prominent = new Uint8Array(bandPower.length);
  const peakFrequencies = [];
  let prominentCount = 0;

  for (let index = 0; index < bandPower.length; index += 1) {
    const floor = localMedian(bandPower, index, 4);
    if (
      10 * Math.log10((bandPower[index] + EPSILON) / (floor + EPSILON)) >=
      prominenceDb
    ) {
      prominent[index] = 1;
      prominentCount += 1;
    }
  }

  for (let index = 1; index + 1 < bandPower.length; index += 1) {
    if (
      prominent[index] &&
      bandPower[index] > bandPower[index - 1] &&
      bandPower[index] >= bandPower[index + 1]
    ) {
      peakFrequencies.push(((firstBin + index) * sampleRate) / FFT_SIZE);
    }
  }

  const occupancy = prominentCount / Math.max(prominent.length, 1);
  const flag = peakFrequencies.length >= 5 && occupancy >= 0.025;
  if (!flag) {
    return { flag, gains };
  }

  const bands = [
    [1000, 1600],
    [1600, 2500],
    [2500, 4000],
    [4000, 6300],
  ];
  bands.forEach(([low, high], bandIndex) => {
    gains[bandIndex] = peakFrequencies.some(
      (frequency) => frequency >= low && frequency < high,
    )
      ? 1
      : 0;
  });
  return { flag, gains };
}

function pushDetectorWindow(history, block, count) {
  if (count >= history.length) {
    history.set(block.subarray(count - history.length, count));
    return;
  }
  history.copyWithin(0, count);
  history.set(block.subarray(0, count), history.length - count);
}

function fillGainRamps(target, starts, ends, bandCount, count) {
  for (let band = 0; band < bandCount; band += 1) {
    const start = starts[band];
    const end = ends[band];
    const base = band * count;
    const denominator = Math.max(count - 1, 1);
    for (let sample = 0; sample < count; sample += 1) {
      target[base + sample] = start + ((end - start) * sample) / denominator;
    }
  }
}

async function processSource(requestId, parameters) {
  if (!sourceSamples) {
    throw new Error("No source audio is loaded");
  }
  const kernel = await kernelPromise;
  kernel.resetState();
  const sampleRate = sourceSampleRate;
  const blockSize = DEMO_CONFIG.blockSize;
  const frameRate = sampleRate / blockSize;
  const output = new Float32Array(sourceSamples.length);
  const frameCount = Math.ceil(sourceSamples.length / blockSize);
  const lowGainDb = new Float32Array(frameCount);
  const highGainDb = new Float32Array(frameCount);
  const flags = new Uint8Array(frameCount);
  const suppressedGain = dbToGain(DEMO_CONFIG.suppressedGainDb);
  const ceiling = dbToGain(DEMO_CONFIG.limiterCeilingDbfs);
  const acousticGains = new Float32Array(3 * blockSize);
  const structuredGains = new Float32Array(4 * blockSize);
  const detectorWindow = new Float32Array(FFT_SIZE);
  const controlled = new Float32Array(blockSize);
  const agcBlock = new Float32Array(blockSize);
  const previousAcoustic = new Float32Array(3).fill(suppressedGain);
  const currentAcoustic = new Float32Array(3).fill(suppressedGain);
  const previousStructured = new Float32Array(4);
  const currentStructured = new Float32Array(4);
  const acousticShort = new Float64Array(3);
  const acousticLong = new Float64Array(3);
  const lowCompressor = { shortEnergy: 0, longEnergy: 0, gain: 1 };
  const highCompressor = { shortEnergy: 0, longEnergy: 0, gain: 1 };
  let lowSidechainGain = 1;
  let highSidechainGain = 1;
  let agcGain = 1;
  let limiterGain = 1;
  let detectorInitialized = false;

  for (let frame = 0; frame < frameCount; frame += 1) {
    if (requestId !== latestRequest) {
      return null;
    }
    const offset = frame * blockSize;
    const count = Math.min(blockSize, sourceSamples.length - offset);
    const input = sourceSamples.subarray(offset, offset + count);

    const whitenedOutput = kernel.processBank(input, count, kernel.whitening);
    const whitened = kernel.band(whitenedOutput, 0, count);
    const agcDetectorOutput = kernel.processBank(whitened, count, kernel.agc);
    const agcDetector = kernel.band(agcDetectorOutput, 0, count);
    const peak = peakAbsolute(agcDetector, count);
    const agcTarget =
      peak > EPSILON ? clamp(dbToGain(-6) / peak, 0.05, 16) : agcGain;
    const nextAgcGain = smoothGain(
      agcGain,
      agcTarget,
      alphaForMs(5, frameRate),
      alphaForMs(30000, frameRate),
    );
    for (let sample = 0; sample < count; sample += 1) {
      const mix = sample / Math.max(count - 1, 1);
      agcBlock[sample] =
        whitened[sample] * (agcGain + (nextAgcGain - agcGain) * mix);
    }
    agcGain = nextAgcGain;

    const splitOutput = kernel.processBank(agcBlock, count, kernel.split);
    const low = kernel.band(splitOutput, 0, count);
    const mid = kernel.band(splitOutput, 1, count);
    const high = kernel.band(splitOutput, 2, count);

    const lowDelta = parameters.low_suppression_db - 10;
    const highDelta = parameters.high_suppression_db - 14;
    updateEnergyCompressor(lowCompressor, low, count, frameRate, {
      shortMs: 10,
      longMs: 250,
      thresholdDb: clamp(6 - lowDelta * 0.3, -12, 18),
      ratio: clamp(4 * 2 ** (lowDelta / 12), 1, 40),
      attackMs: 5,
      releaseMs: 200,
    });
    updateEnergyCompressor(highCompressor, high, count, frameRate, {
      shortMs: 10,
      longMs: 250,
      thresholdDb: clamp(6 - highDelta * 0.3, -12, 18),
      ratio: clamp(4 * 2 ** (highDelta / 12), 1, 40),
      attackMs: 2,
      releaseMs: 200,
    });

    const midRms = Math.sqrt(meanSquare(mid, count) + EPSILON);
    const threshold = midRms * dbToGain(-24);
    lowSidechainGain = smoothGain(
      lowSidechainGain,
      compressorGain(
        Math.sqrt(meanSquare(low, count) + EPSILON),
        threshold,
        8,
      ),
      alphaForMs(2000, frameRate),
      alphaForMs(2000, frameRate),
    );
    highSidechainGain = smoothGain(
      highSidechainGain,
      compressorGain(
        Math.sqrt(meanSquare(high, count) + EPSILON),
        threshold,
        8,
      ),
      alphaForMs(2000, frameRate),
      alphaForMs(2000, frameRate),
    );
    const effectiveLow = applySuppressionMapping(
      lowCompressor.gain * lowSidechainGain,
      parameters.low_suppression_db,
      10,
    );
    const effectiveHigh = applySuppressionMapping(
      highCompressor.gain * highSidechainGain,
      parameters.high_suppression_db,
      14,
    );
    lowGainDb[frame] = gainToDb(effectiveLow);
    highGainDb[frame] = gainToDb(effectiveHigh);

    for (let sample = 0; sample < count; sample += 1) {
      controlled[sample] =
        low[sample] * effectiveLow + mid[sample] + high[sample] * effectiveHigh;
    }

    const acousticOutput = kernel.processBank(
      controlled,
      count,
      kernel.acoustic,
    );
    kernel.processBank(controlled, count, kernel.structured);
    let transientFlag = false;
    previousAcoustic.set(currentAcoustic);

    for (let band = 0; band < 3; band += 1) {
      const bandValues = kernel.band(acousticOutput, band, count);
      const energy = meanSquare(bandValues, count) + EPSILON;
      if (!detectorInitialized) {
        acousticShort[band] = energy;
        acousticLong[band] = energy;
      } else {
        const shortAlpha = alphaForMs(30, frameRate);
        const longAlpha = alphaForMs(250, frameRate);
        acousticShort[band] =
          shortAlpha * acousticShort[band] + (1 - shortAlpha) * energy;
        acousticLong[band] =
          longAlpha * acousticLong[band] + (1 - longAlpha) * energy;
      }
      const score = detectorInitialized
        ? Math.max(
            0,
            10 *
              Math.log10(
                (acousticShort[band] + EPSILON) /
                  (acousticLong[band] + EPSILON),
              ),
          )
        : 0;
      const active = score >= parameters.transient_threshold_db;
      transientFlag ||= active;
      const target = active ? 1 : suppressedGain;
      currentAcoustic[band] = smoothGain(
        currentAcoustic[band],
        target,
        alphaForMs(5, frameRate),
        alphaForMs(100, frameRate),
      );
    }
    detectorInitialized = true;

    pushDetectorWindow(detectorWindow, controlled, count);
    const structured = structuredDetection(
      detectorWindow,
      sampleRate,
      parameters.harmonic_threshold_db,
    );
    previousStructured.set(currentStructured);
    for (let band = 0; band < 4; band += 1) {
      currentStructured[band] = smoothGain(
        currentStructured[band],
        structured.gains[band],
        alphaForMs(10, frameRate),
        alphaForMs(200, frameRate),
      );
    }
    flags[frame] = (transientFlag ? 1 : 0) | (structured.flag ? 2 : 0);
    fillGainRamps(
      acousticGains,
      previousAcoustic,
      currentAcoustic,
      3,
      count,
    );
    fillGainRamps(
      structuredGains,
      previousStructured,
      currentStructured,
      4,
      count,
    );

    const rendered = kernel.render(
      controlled,
      acousticGains.subarray(0, 3 * count),
      structuredGains.subarray(0, 4 * count),
      count,
      suppressedGain,
    );
    const renderPeak = peakAbsolute(rendered, count);
    const limiterTarget = Math.min(
      1,
      ceiling / Math.max(renderPeak, EPSILON),
    );
    const nextLimiterGain =
      limiterTarget < limiterGain
        ? limiterTarget
        : alphaForMs(50, frameRate) * limiterGain +
          (1 - alphaForMs(50, frameRate));
    const limited = kernel.limit(
      rendered,
      count,
      limiterGain,
      nextLimiterGain,
      ceiling,
    );
    output.set(limited.subarray(0, count), offset);
    limiterGain = nextLimiterGain;

    if (frame % 96 === 0 || frame === frameCount - 1) {
      self.postMessage({
        type: "progress",
        requestId,
        progress: (frame + 1) / frameCount,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  return {
    output,
    lowGainDb,
    highGainDb,
    flags,
    meterInterval: blockSize / sampleRate,
    peak: peakAbsolute(output),
    rms: Math.sqrt(meanSquare(output) + EPSILON),
  };
}

self.addEventListener("message", async (event) => {
  const message = event.data;
  if (message.type === "load") {
    sourceSamples = new Float32Array(message.samples);
    sourceSampleRate = message.sampleRate;
    latestRequest = message.requestId;
    kernelPromise = createKernel(sourceSampleRate);
  } else if (message.type === "process") {
    latestRequest = message.requestId;
  } else {
    return;
  }

  try {
    const result = await processSource(message.requestId, message.parameters);
    if (!result || message.requestId !== latestRequest) {
      return;
    }
    self.postMessage(
      {
        type: "result",
        requestId: message.requestId,
        sampleRate: sourceSampleRate,
        processed: result.output.buffer,
        lowGainDb: result.lowGainDb.buffer,
        highGainDb: result.highGainDb.buffer,
        flags: result.flags.buffer,
        meterInterval: result.meterInterval,
        peak: result.peak,
        rms: result.rms,
      },
      [
        result.output.buffer,
        result.lowGainDb.buffer,
        result.highGainDb.buffer,
        result.flags.buffer,
      ],
    );
  } catch (error) {
    self.postMessage({
      type: "error",
      requestId: message.requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
