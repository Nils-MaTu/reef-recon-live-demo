import { DEMO_CONFIG } from "./config.js";

const EPSILON = 1e-12;
const FFT_SIZE = 512;
const IDENTITY = [1, 0, 0, 0, 0];

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

function createKernel(sampleRate, wasmBytes) {
  const module = new WebAssembly.Module(wasmBytes);
  const instance = new WebAssembly.Instance(module, {
    env: {
      abort() {
        throw new Error("WebAssembly aborted");
      },
    },
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

class ReefReconProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const wasmBytes = options.processorOptions.wasmBytes;
    this.parameters = { ...options.processorOptions.parameters };
    this.kernel = createKernel(sampleRate, wasmBytes);
    this.blockSize = DEMO_CONFIG.blockSize;
    this.frameRate = sampleRate / this.blockSize;
    this.suppressedGain = dbToGain(DEMO_CONFIG.suppressedGainDb);
    this.ceiling = dbToGain(DEMO_CONFIG.limiterCeilingDbfs);
    this.inputBlock = new Float32Array(this.blockSize);
    this.outputBlock = new Float32Array(this.blockSize);
    this.inputOffset = 0;
    this.outputOffset = 0;
    this.acousticGains = new Float32Array(3 * this.blockSize);
    this.structuredGains = new Float32Array(4 * this.blockSize);
    this.detectorWindow = new Float32Array(FFT_SIZE);
    this.controlled = new Float32Array(this.blockSize);
    this.agcBlock = new Float32Array(this.blockSize);
    this.previousAcoustic = new Float32Array(3);
    this.currentAcoustic = new Float32Array(3);
    this.previousStructured = new Float32Array(4);
    this.currentStructured = new Float32Array(4);
    this.acousticShort = new Float64Array(3);
    this.acousticLong = new Float64Array(3);
    this.lowCompressor = { shortEnergy: 0, longEnergy: 0, gain: 1 };
    this.highCompressor = { shortEnergy: 0, longEnergy: 0, gain: 1 };
    this.lowSidechainGain = 1;
    this.highSidechainGain = 1;
    this.agcGain = 1;
    this.limiterGain = 1;
    this.referenceGain = this.suppressedGain;
    this.detectorInitialized = false;
    this.blockCounter = 0;
    this.reset();

    this.port.onmessage = (event) => {
      const message = event.data;
      if (message.type === "parameters") {
        this.parameters = { ...this.parameters, ...message.parameters };
        this.port.postMessage({
          type: "parameters-applied",
          version: message.version,
        });
      } else if (message.type === "reset") {
        this.reset();
      }
    };
    this.port.postMessage({ type: "ready" });
  }

  reset() {
    this.kernel.resetState();
    this.inputBlock.fill(0);
    this.outputBlock.fill(0);
    this.inputOffset = 0;
    this.outputOffset = 0;
    this.detectorWindow.fill(0);
    this.previousAcoustic.fill(this.suppressedGain);
    this.currentAcoustic.fill(this.suppressedGain);
    this.previousStructured.fill(0);
    this.currentStructured.fill(0);
    this.acousticShort.fill(0);
    this.acousticLong.fill(0);
    this.lowCompressor = { shortEnergy: 0, longEnergy: 0, gain: 1 };
    this.highCompressor = { shortEnergy: 0, longEnergy: 0, gain: 1 };
    this.lowSidechainGain = 1;
    this.highSidechainGain = 1;
    this.agcGain = 1;
    this.limiterGain = 1;
    this.referenceGain = this.suppressedGain;
    this.detectorInitialized = false;
    this.blockCounter = 0;
  }

  processBlock(input) {
    const count = this.blockSize;
    const parameters = this.parameters;
    const whitenedOutput = this.kernel.processBank(
      input,
      count,
      this.kernel.whitening,
    );
    const whitened = this.kernel.band(whitenedOutput, 0, count);
    const agcDetectorOutput = this.kernel.processBank(
      whitened,
      count,
      this.kernel.agc,
    );
    const agcDetector = this.kernel.band(agcDetectorOutput, 0, count);
    const peak = peakAbsolute(agcDetector, count);
    const agcTarget =
      peak > EPSILON ? clamp(dbToGain(-6) / peak, 0.05, 16) : this.agcGain;
    const nextAgcGain = smoothGain(
      this.agcGain,
      agcTarget,
      alphaForMs(5, this.frameRate),
      alphaForMs(30000, this.frameRate),
    );
    for (let sample = 0; sample < count; sample += 1) {
      const mix = sample / (count - 1);
      this.agcBlock[sample] =
        whitened[sample] *
        (this.agcGain + (nextAgcGain - this.agcGain) * mix);
    }
    this.agcGain = nextAgcGain;
    const inputRms = Math.sqrt(meanSquare(input, count) + EPSILON);
    const baselineRms =
      Math.sqrt(meanSquare(this.agcBlock, count) + EPSILON) *
      this.suppressedGain;
    if (inputRms > dbToGain(-80)) {
      const referenceTarget = clamp(baselineRms / inputRms, 0.01, 1.5);
      const referenceAlpha = alphaForMs(750, this.frameRate);
      this.referenceGain =
        referenceAlpha * this.referenceGain +
        (1 - referenceAlpha) * referenceTarget;
    }

    const splitOutput = this.kernel.processBank(
      this.agcBlock,
      count,
      this.kernel.split,
    );
    const low = this.kernel.band(splitOutput, 0, count);
    const mid = this.kernel.band(splitOutput, 1, count);
    const high = this.kernel.band(splitOutput, 2, count);
    const lowDelta = parameters.low_suppression_db - 10;
    const highDelta = parameters.high_suppression_db - 14;
    updateEnergyCompressor(
      this.lowCompressor,
      low,
      count,
      this.frameRate,
      {
        shortMs: 10,
        longMs: 250,
        thresholdDb: clamp(6 - lowDelta * 0.3, -12, 18),
        ratio: clamp(4 * 2 ** (lowDelta / 12), 1, 40),
        attackMs: 5,
        releaseMs: 200,
      },
    );
    updateEnergyCompressor(
      this.highCompressor,
      high,
      count,
      this.frameRate,
      {
        shortMs: 10,
        longMs: 250,
        thresholdDb: clamp(6 - highDelta * 0.3, -12, 18),
        ratio: clamp(4 * 2 ** (highDelta / 12), 1, 40),
        attackMs: 2,
        releaseMs: 200,
      },
    );

    const midRms = Math.sqrt(meanSquare(mid, count) + EPSILON);
    const threshold = midRms * dbToGain(-24);
    this.lowSidechainGain = smoothGain(
      this.lowSidechainGain,
      compressorGain(
        Math.sqrt(meanSquare(low, count) + EPSILON),
        threshold,
        8,
      ),
      alphaForMs(2000, this.frameRate),
      alphaForMs(2000, this.frameRate),
    );
    this.highSidechainGain = smoothGain(
      this.highSidechainGain,
      compressorGain(
        Math.sqrt(meanSquare(high, count) + EPSILON),
        threshold,
        8,
      ),
      alphaForMs(2000, this.frameRate),
      alphaForMs(2000, this.frameRate),
    );
    const effectiveLow = applySuppressionMapping(
      this.lowCompressor.gain * this.lowSidechainGain,
      parameters.low_suppression_db,
      10,
    );
    const effectiveHigh = applySuppressionMapping(
      this.highCompressor.gain * this.highSidechainGain,
      parameters.high_suppression_db,
      14,
    );
    for (let sample = 0; sample < count; sample += 1) {
      this.controlled[sample] =
        low[sample] * effectiveLow +
        mid[sample] +
        high[sample] * effectiveHigh;
    }

    const acousticOutput = this.kernel.processBank(
      this.controlled,
      count,
      this.kernel.acoustic,
    );
    this.kernel.processBank(this.controlled, count, this.kernel.structured);
    let transientFlag = false;
    this.previousAcoustic.set(this.currentAcoustic);
    for (let band = 0; band < 3; band += 1) {
      const bandValues = this.kernel.band(acousticOutput, band, count);
      const energy = meanSquare(bandValues, count) + EPSILON;
      if (!this.detectorInitialized) {
        this.acousticShort[band] = energy;
        this.acousticLong[band] = energy;
      } else {
        const shortAlpha = alphaForMs(30, this.frameRate);
        const longAlpha = alphaForMs(250, this.frameRate);
        this.acousticShort[band] =
          shortAlpha * this.acousticShort[band] + (1 - shortAlpha) * energy;
        this.acousticLong[band] =
          longAlpha * this.acousticLong[band] + (1 - longAlpha) * energy;
      }
      const score = this.detectorInitialized
        ? Math.max(
            0,
            10 *
              Math.log10(
                (this.acousticShort[band] + EPSILON) /
                  (this.acousticLong[band] + EPSILON),
              ),
          )
        : 0;
      const active = score >= parameters.transient_threshold_db;
      transientFlag ||= active;
      this.currentAcoustic[band] = smoothGain(
        this.currentAcoustic[band],
        active ? 1 : this.suppressedGain,
        alphaForMs(5, this.frameRate),
        alphaForMs(100, this.frameRate),
      );
    }
    this.detectorInitialized = true;

    pushDetectorWindow(this.detectorWindow, this.controlled, count);
    const structured = structuredDetection(
      this.detectorWindow,
      sampleRate,
      parameters.harmonic_threshold_db,
    );
    this.previousStructured.set(this.currentStructured);
    for (let band = 0; band < 4; band += 1) {
      this.currentStructured[band] = smoothGain(
        this.currentStructured[band],
        structured.gains[band],
        alphaForMs(10, this.frameRate),
        alphaForMs(200, this.frameRate),
      );
    }
    fillGainRamps(
      this.acousticGains,
      this.previousAcoustic,
      this.currentAcoustic,
      3,
      count,
    );
    fillGainRamps(
      this.structuredGains,
      this.previousStructured,
      this.currentStructured,
      4,
      count,
    );

    const rendered = this.kernel.render(
      this.controlled,
      this.acousticGains,
      this.structuredGains,
      count,
      this.suppressedGain,
    );
    const limiterTarget = Math.min(
      1,
      this.ceiling / Math.max(peakAbsolute(rendered, count), EPSILON),
    );
    const nextLimiterGain =
      limiterTarget < this.limiterGain
        ? limiterTarget
        : alphaForMs(50, this.frameRate) * this.limiterGain +
          (1 - alphaForMs(50, this.frameRate));
    const limited = this.kernel.limit(
      rendered,
      count,
      this.limiterGain,
      nextLimiterGain,
      this.ceiling,
    );
    this.outputBlock.set(limited);
    this.limiterGain = nextLimiterGain;
    this.blockCounter += 1;

    if (this.blockCounter % 8 === 0) {
      this.port.postMessage({
        type: "meter",
        lowGainDb: gainToDb(effectiveLow),
        highGainDb: gainToDb(effectiveHigh),
        transient: transientFlag,
        harmonic: structured.flag,
        referenceGain: this.referenceGain,
      });
    }
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!output) {
      return true;
    }
    const quantum = output.length;
    output.set(
      this.outputBlock.subarray(
        this.outputOffset,
        this.outputOffset + quantum,
      ),
    );
    this.outputOffset += quantum;
    if (this.outputOffset >= this.blockSize) {
      this.outputOffset = 0;
    }

    if (input) {
      this.inputBlock.set(input, this.inputOffset);
    } else {
      this.inputBlock.fill(0, this.inputOffset, this.inputOffset + quantum);
    }
    this.inputOffset += quantum;
    if (this.inputOffset >= this.blockSize) {
      this.inputOffset = 0;
      this.processBlock(this.inputBlock);
    }
    return true;
  }
}

registerProcessor("reef-recon-processor", ReefReconProcessor);
