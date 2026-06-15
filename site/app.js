import { DEMO_CONFIG, valuesForLevels } from "./config.js?v=20260615-1";

const SPECTROGRAM_DB_MIN = -100;
const SPECTROGRAM_DB_MAX = -45;

const els = {
  status: document.querySelector("#statusText"),
  progress: document.querySelector("#progressBar"),
  power: document.querySelector("#powerButton"),
  bypass: document.querySelector("#bypassButton"),
  file: document.querySelector("#fileSelect"),
  upload: document.querySelector("#uploadInput"),
  loop: document.querySelector("#loopButton"),
  controls: document.querySelector("#controlSurface"),
  time: document.querySelector("#timeReadout"),
  waveformTitle: document.querySelector("#waveformTitle"),
  source: document.querySelector("#sourceReadout"),
  meter: document.querySelector("#meterReadout"),
};

const state = {
  levels: { ...DEMO_CONFIG.defaultLevels },
  controls: new Map(),
  sourceLabel: "",
  sourceData: null,
  uploadedFile: null,
  meter: null,
  bypass: false,
  loopActive: false,
  loopStart: 0.15,
  loopEnd: 0.85,
  lastVisualTime: 0,
  loadVersion: 0,
};

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function dbToGain(db) {
  return 10 ** (db / 20);
}

function setStatus(message, progress = 0) {
  els.status.textContent = `${message} · browser DSP`;
  els.progress.style.width = `${clamp(progress, 0, 1) * 100}%`;
}

function formatValue(value, unit) {
  return `${Number(value).toFixed(1)} ${unit}`;
}

function resizeCanvas(canvas) {
  const ratio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width * ratio));
  const height = Math.max(1, Math.floor(rect.height * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    return true;
  }
  return false;
}

function monoSamples(buffer) {
  const mono = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const source = buffer.getChannelData(channel);
    for (let index = 0; index < source.length; index += 1) {
      mono[index] += source[index] / buffer.numberOfChannels;
    }
  }
  return mono;
}

function resampleLinear(samples, sourceRate, targetRate) {
  if (sourceRate === targetRate) {
    return samples;
  }
  const targetLength = Math.max(
    1,
    Math.round((samples.length * targetRate) / sourceRate),
  );
  const output = new Float32Array(targetLength);
  const scale = sourceRate / targetRate;
  for (let index = 0; index < targetLength; index += 1) {
    const sourcePosition = index * scale;
    const left = Math.floor(sourcePosition);
    const right = Math.min(samples.length - 1, left + 1);
    const mix = sourcePosition - left;
    output[index] = samples[left] + (samples[right] - samples[left]) * mix;
  }
  return output;
}

function normalizeDemoAudio(samples, sampleRate) {
  let energy = 0;
  let peak = 0;
  for (const sample of samples) {
    energy += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
  }
  const rms = Math.sqrt(energy / Math.max(samples.length, 1));
  const targetGain = dbToGain(-30) / Math.max(rms, 1e-8);
  const peakGain = 0.95 / Math.max(peak, 1e-8);
  const gain = Math.min(targetGain, peakGain, 24);
  const output = new Float32Array(samples.length);
  const fadeSamples = Math.min(
    samples.length,
    Math.max(1, Math.round(sampleRate * 0.01)),
  );
  for (let index = 0; index < samples.length; index += 1) {
    let fade = 1;
    if (index < fadeSamples) {
      fade *= index / fadeSamples;
    }
    if (index >= samples.length - fadeSamples) {
      fade *= (samples.length - index - 1) / fadeSamples;
    }
    output[index] = samples[index] * gain * Math.max(0, fade);
  }
  return output;
}

class SwitchControl {
  constructor(spec, level, onChange) {
    this.spec = spec;
    this.level = level;

    this.root = document.createElement("fieldset");
    this.root.className = "control switch-control";
    this.legend = document.createElement("legend");
    this.legend.textContent = spec.label;
    this.group = document.createElement("div");
    this.group.className = "switch-group";

    for (const optionLevel of ["high", "med", "low"]) {
      const id = `${spec.id}-${optionLevel}`;
      const input = document.createElement("input");
      input.type = "radio";
      input.name = spec.id;
      input.id = id;
      input.value = optionLevel;
      input.checked = optionLevel === level;

      const label = document.createElement("label");
      label.htmlFor = id;
      label.textContent = optionLevel.toUpperCase();
      label.title = spec.showValue === false
        ? spec.label
        : `${spec.label}: ${formatValue(spec.levels[optionLevel], spec.unit)}`;

      input.addEventListener("change", () => {
        if (!input.checked) {
          return;
        }
        this.level = optionLevel;
        this.updateReadout();
        onChange(spec.id, optionLevel);
      });
      this.group.append(input, label);
    }

    if (spec.showValue !== false) {
      this.readout = document.createElement("div");
      this.readout.className = "readout";
      this.updateReadout();
      this.root.append(this.legend, this.group, this.readout);
    } else {
      this.root.append(this.legend, this.group);
    }
  }

  updateReadout() {
    if (!this.readout) {
      return;
    }
    this.readout.textContent = formatValue(
      this.spec.levels[this.level],
      this.spec.unit,
    );
  }
}

class AudioEngine {
  constructor(parameters) {
    this.context = null;
    this.nodes = null;
    this.originalBuffer = null;
    this.originalSource = null;
    this.worklet = null;
    this.parameters = { ...parameters };
    this.parameterVersion = 0;
    this.playing = false;
    this.bypass = false;
    this.dryReferenceGain = dbToGain(DEMO_CONFIG.suppressedGainDb);
    this.loopEnabled = false;
    this.loopStart = 0;
    this.loopEnd = 1;
    this.offset = 0;
    this.startedAt = 0;
    this.onMeter = () => {};
    this.onParametersApplied = () => {};
  }

  get duration() {
    return this.originalBuffer ? this.originalBuffer.duration : 1;
  }

  get currentTime() {
    if (!this.playing || !this.context) {
      return this.offset;
    }
    const elapsed = this.context.currentTime - this.startedAt;
    if (this.loopEnabled) {
      const length = Math.max(0.01, this.loopEnd - this.loopStart);
      const relative =
        ((this.offset - this.loopStart + elapsed) % length + length) % length;
      return this.loopStart + relative;
    }
    return (this.offset + elapsed) % this.duration;
  }

  get originalAnalyser() {
    return this.nodes?.originalAnalyser || null;
  }

  get processedAnalyser() {
    return this.nodes?.processedAnalyser || null;
  }

  get monitorAnalyser() {
    return this.nodes?.monitorAnalyser || null;
  }

  async ensureContext(resume = true) {
    if (!this.context) {
      this.context = new AudioContext({ sampleRate: DEMO_CONFIG.sampleRate });
      await this.context.audioWorklet.addModule(
        new URL("./audio-worklet.js?v=20260615-1", import.meta.url),
      );
      const wasmResponse = await fetch(
        new URL("./dsp-core.wasm?v=20260615-1", import.meta.url),
      );
      if (!wasmResponse.ok) {
        throw new Error(`Could not load WebAssembly core (${wasmResponse.status})`);
      }
      const wasmBytes = await wasmResponse.arrayBuffer();
      const originalAnalyser = this.context.createAnalyser();
      const processedAnalyser = this.context.createAnalyser();
      const originalGain = this.context.createGain();
      const processedGain = this.context.createGain();
      const dryDelay = this.context.createDelay(1);
      const monitorAnalyser = this.context.createAnalyser();
      const outputGain = this.context.createGain();
      this.worklet = new AudioWorkletNode(
        this.context,
        "reef-recon-processor",
        {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          processorOptions: {
            wasmBytes,
            parameters: this.parameters,
          },
        },
      );

      for (const analyser of [
        originalAnalyser,
        processedAnalyser,
        monitorAnalyser,
      ]) {
        analyser.fftSize = 2048;
        analyser.minDecibels = -110;
        analyser.maxDecibels = -30;
        analyser.smoothingTimeConstant = 0.22;
      }

      originalAnalyser.connect(dryDelay);
      dryDelay.connect(originalGain);
      originalGain.connect(monitorAnalyser);
      this.worklet.connect(processedAnalyser);
      processedAnalyser.connect(processedGain);
      processedGain.connect(monitorAnalyser);
      monitorAnalyser.connect(outputGain);
      outputGain.connect(this.context.destination);
      dryDelay.delayTime.value =
        DEMO_CONFIG.blockSize / DEMO_CONFIG.sampleRate;
      originalGain.gain.value = this.bypass
        ? this.dryReferenceGain
        : 0;
      processedGain.gain.value = this.bypass ? 0 : 1;
      outputGain.gain.value = dbToGain(DEMO_CONFIG.outputGainDb);
      this.worklet.port.onmessage = (event) => {
        const message = event.data;
        if (message.type === "meter") {
          this.onMeter(message);
        } else if (message.type === "parameters-applied") {
          this.onParametersApplied(message.version);
        }
      };
      this.nodes = {
        originalAnalyser,
        processedAnalyser,
        originalGain,
        processedGain,
        dryDelay,
        monitorAnalyser,
        outputGain,
      };
    }
    if (resume) {
      await this.context.resume();
    }
  }

  createBuffer(samples) {
    const buffer = this.context.createBuffer(
      1,
      samples.length,
      DEMO_CONFIG.sampleRate,
    );
    buffer.copyToChannel(samples, 0);
    return buffer;
  }

  stopSource(source) {
    if (!source) {
      return;
    }
    try {
      source.stop();
    } catch {
      // A source may already have stopped during a rapid parameter change.
    }
  }

  createLoopingSource(buffer) {
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.loopStart = this.loopEnabled ? this.loopStart : 0;
    source.loopEnd = this.loopEnabled ? this.loopEnd : this.duration;
    source.connect(this.nodes.originalAnalyser);
    source.connect(this.worklet);
    return source;
  }

  async decode(arrayBuffer) {
    await this.ensureContext(false);
    const decoded = await this.context.decodeAudioData(arrayBuffer.slice(0));
    const mono = monoSamples(decoded);
    const resampled = resampleLinear(
      mono,
      decoded.sampleRate,
      DEMO_CONFIG.sampleRate,
    );
    if (
      resampled.length >
      DEMO_CONFIG.maxUploadMinutes * 60 * DEMO_CONFIG.sampleRate
    ) {
      throw new Error(
        `Audio must be ${DEMO_CONFIG.maxUploadMinutes} minutes or shorter`,
      );
    }
    return normalizeDemoAudio(resampled, DEMO_CONFIG.sampleRate);
  }

  async setSource(originalSamples) {
    await this.ensureContext(false);
    this.stop();
    this.originalBuffer = this.createBuffer(originalSamples);
    this.loopStart = clamp(this.loopStart, 0, this.duration - 0.01);
    this.loopEnd = clamp(this.loopEnd, this.loopStart + 0.01, this.duration);
    this.offset = 0;
  }

  setParameters(parameters) {
    this.parameters = { ...parameters };
    this.parameterVersion += 1;
    this.worklet?.port.postMessage({
      type: "parameters",
      version: this.parameterVersion,
      parameters: this.parameters,
    });
    return this.parameterVersion;
  }

  async play() {
    if (!this.originalBuffer) {
      return;
    }
    await this.ensureContext();
    const time = this.loopEnabled
      ? clamp(this.offset, this.loopStart, this.loopEnd - 0.001)
      : this.offset % this.duration;
    this.worklet.port.postMessage({ type: "reset" });
    this.originalSource = this.createLoopingSource(this.originalBuffer);
    this.originalSource.start(0, time);
    this.startedAt = this.context.currentTime;
    this.playing = true;
  }

  restartAt(time) {
    if (!this.playing || !this.context || !this.originalBuffer) {
      this.offset = time;
      return;
    }
    this.stopSource(this.originalSource);
    this.originalSource = this.createLoopingSource(this.originalBuffer);
    this.originalSource.start(0, time);
    this.offset = time;
    this.startedAt = this.context.currentTime;
  }

  setLoop(enabled, start, end) {
    const current = this.currentTime;
    this.loopEnabled = enabled;
    this.loopStart = clamp(start, 0, Math.max(0, this.duration - 0.01));
    this.loopEnd = clamp(end, this.loopStart + 0.01, this.duration);

    if (this.originalSource) {
      this.originalSource.loopStart = enabled ? this.loopStart : 0;
      this.originalSource.loopEnd = enabled ? this.loopEnd : this.duration;
    }

    if (enabled && (current < this.loopStart || current >= this.loopEnd)) {
      this.restartAt(this.loopStart);
      return;
    }
    this.offset = current;
    if (this.context) {
      this.startedAt = this.context.currentTime;
    }
  }

  stop() {
    this.stopSource(this.originalSource);
    this.originalSource = null;
    this.worklet?.port.postMessage({ type: "reset" });
    this.playing = false;
    this.offset = 0;
  }

  holdAndRamp(parameter, value, seconds) {
    const now = this.context.currentTime;
    if (typeof parameter.cancelAndHoldAtTime === "function") {
      parameter.cancelAndHoldAtTime(now);
    } else {
      const current = parameter.value;
      parameter.cancelScheduledValues(now);
      parameter.setValueAtTime(current, now);
    }
    parameter.linearRampToValueAtTime(value, now + seconds);
  }

  setBypass(bypassed) {
    this.bypass = bypassed;
    if (!this.context) {
      return;
    }
    this.holdAndRamp(
      this.nodes.originalGain.gain,
      bypassed ? this.dryReferenceGain : 0,
      0.08,
    );
    this.holdAndRamp(this.nodes.processedGain.gain, bypassed ? 0 : 1, 0.08);
  }

  setReferenceGain(gain) {
    if (!Number.isFinite(gain)) {
      return;
    }
    this.dryReferenceGain = clamp(gain, 0.01, 1.5);
    if (this.bypass && this.context) {
      this.holdAndRamp(
        this.nodes.originalGain.gain,
        this.dryReferenceGain,
        0.12,
      );
    }
  }
}

class Spectrogram {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false });
    this.sampleRate = DEMO_CONFIG.sampleRate;
    this.duration = 1;
    this.minFreq = 80;
    this.maxFreq = Math.min(12000, this.sampleRate * 0.5);
    this.margin = { left: 48, right: 10, top: 8, bottom: 28 };
    this.frequencyData = null;
    this.lastX = -1;
    this.clear();
  }

  setSource(sampleRate, duration) {
    this.sampleRate = sampleRate;
    this.duration = Math.max(0.01, duration);
    this.maxFreq = Math.min(12000, sampleRate * 0.5);
    this.clear();
  }

  metrics() {
    const ratio = window.devicePixelRatio || 1;
    const left = Math.round(this.margin.left * ratio);
    const right = Math.round(this.margin.right * ratio);
    const top = Math.round(this.margin.top * ratio);
    const bottom = Math.round(this.margin.bottom * ratio);
    return {
      ratio,
      left,
      right,
      top,
      bottom,
      width: Math.max(1, this.canvas.width - left - right),
      height: Math.max(1, this.canvas.height - top - bottom),
    };
  }

  clear() {
    resizeCanvas(this.canvas);
    this.lastX = -1;
    this.ctx.fillStyle = "#000000";
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.drawAxes();
  }

  draw(analyser, time, flags = null) {
    if (!analyser) {
      return;
    }
    if (resizeCanvas(this.canvas)) {
      this.clear();
    }
    const metrics = this.metrics();
    const x = clamp(
      Math.floor(
        metrics.left + (time / this.duration) * metrics.width,
      ),
      metrics.left,
      metrics.left + metrics.width - 1,
    );
    if (x < this.lastX - 2) {
      this.clear();
    }
    if (x === this.lastX) {
      return;
    }
    this.lastX = x;

    if (
      !this.frequencyData ||
      this.frequencyData.length !== analyser.frequencyBinCount
    ) {
      this.frequencyData = new Float32Array(analyser.frequencyBinCount);
    }
    analyser.getFloatFrequencyData(this.frequencyData);
    this.drawColumn(x, this.frequencyData, analyser.fftSize);
    if (flags && (flags.transient || flags.harmonic)) {
      this.highlight(x, flags);
    }
    this.drawAxes();
  }

  drawColumn(x, data, fftSize) {
    const metrics = this.metrics();
    const image = this.ctx.createImageData(1, metrics.height);
    const frequencyRatio = this.maxFreq / this.minFreq;
    const span = SPECTROGRAM_DB_MAX - SPECTROGRAM_DB_MIN;
    for (let y = 0; y < metrics.height; y += 1) {
      const normalizedY = 1 - y / Math.max(1, metrics.height - 1);
      const frequency = this.minFreq * frequencyRatio ** normalizedY;
      const bin = clamp(
        Math.round((frequency / this.sampleRate) * fftSize),
        0,
        data.length - 1,
      );
      const tone = clamp((data[bin] - SPECTROGRAM_DB_MIN) / span, 0, 1);
      const [red, green, blue] = this.color(tone);
      const offset = y * 4;
      image.data[offset] = red;
      image.data[offset + 1] = green;
      image.data[offset + 2] = blue;
      image.data[offset + 3] = 255;
    }
    this.ctx.putImageData(image, x, metrics.top);
  }

  highlight(x, flags) {
    const metrics = this.metrics();
    this.ctx.save();
    if (flags.transient) {
      this.ctx.fillStyle = "rgba(30, 220, 169, 0.22)";
      this.ctx.fillRect(
        x,
        metrics.top,
        Math.max(2, metrics.ratio * 2),
        metrics.height,
      );
    }
    if (flags.harmonic) {
      this.ctx.fillStyle = "rgba(255, 176, 64, 0.24)";
      this.ctx.fillRect(
        x,
        metrics.top,
        Math.max(2, metrics.ratio * 2),
        metrics.height,
      );
    }
    this.ctx.restore();
  }

  drawAxes() {
    const metrics = this.metrics();
    const right = metrics.left + metrics.width;
    const bottom = metrics.top + metrics.height;
    const context = this.ctx;
    context.save();
    context.fillStyle = "#000000";
    context.fillRect(0, 0, metrics.left, this.canvas.height);
    context.fillRect(
      0,
      bottom,
      this.canvas.width,
      this.canvas.height - bottom,
    );
    context.fillRect(
      right,
      0,
      this.canvas.width - right,
      this.canvas.height,
    );
    context.strokeStyle = "rgba(120, 120, 120, 0.14)";
    context.lineWidth = Math.max(1, metrics.ratio);
    context.strokeRect(
      metrics.left,
      metrics.top,
      metrics.width,
      metrics.height,
    );
    context.font = `${Math.round(10 * metrics.ratio)}px Inter, system-ui, sans-serif`;
    context.textBaseline = "middle";
    context.textAlign = "right";
    context.fillStyle = "rgba(152, 152, 157, 0.55)";

    const frequencyTicks = [100, 250, 500, 1000, 2500, 5000, 10000].filter(
      (frequency) =>
        frequency >= this.minFreq && frequency <= this.maxFreq,
    );
    for (const frequency of frequencyTicks) {
      const normalized =
        Math.log(frequency / this.minFreq) /
        Math.log(this.maxFreq / this.minFreq);
      const y = metrics.top + (1 - normalized) * metrics.height;
      context.strokeStyle = "rgba(120, 120, 120, 0.08)";
      context.beginPath();
      context.moveTo(metrics.left, y);
      context.lineTo(right, y);
      context.stroke();
      const label =
        frequency >= 1000
          ? `${Number.isInteger(frequency / 1000) ? frequency / 1000 : (frequency / 1000).toFixed(1)}k`
          : String(frequency);
      context.fillText(label, metrics.left - 7 * metrics.ratio, y);
    }

    context.textAlign = "center";
    context.textBaseline = "top";
    const timeStep = this.duration <= 12 ? 2 : this.duration <= 30 ? 5 : 10;
    for (let time = 0; time <= this.duration + 1e-6; time += timeStep) {
      const x = metrics.left + (time / this.duration) * metrics.width;
      context.strokeStyle = "rgba(120, 120, 120, 0.08)";
      context.beginPath();
      context.moveTo(x, metrics.top);
      context.lineTo(x, bottom);
      context.stroke();
      context.fillText(
        `${Math.round(time)}s`,
        x,
        bottom + 6 * metrics.ratio,
      );
    }
    context.restore();
  }

  color(tone) {
    const stops = [
      [0, [0, 0, 0]],
      [0.18, [10, 18, 32]],
      [0.42, [18, 58, 108]],
      [0.65, [38, 126, 198]],
      [0.82, [110, 188, 245]],
      [1, [245, 248, 252]],
    ];
    for (let index = 1; index < stops.length; index += 1) {
      if (tone <= stops[index][0]) {
        const [leftTone, left] = stops[index - 1];
        const [rightTone, right] = stops[index];
        const mix = (tone - leftTone) / (rightTone - leftTone);
        return left.map((channel, channelIndex) =>
          Math.round(channel + (right[channelIndex] - channel) * mix),
        );
      }
    }
    return stops.at(-1)[1];
  }
}

class WaveformScope {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false });
    this.samples = null;
  }

  clear() {
    resizeCanvas(this.canvas);
    this.ctx.fillStyle = "#000000";
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  draw(analyser) {
    resizeCanvas(this.canvas);
    const { width, height } = this.canvas;
    const context = this.ctx;
    context.fillStyle = "#000000";
    context.fillRect(0, 0, width, height);
    context.strokeStyle = "rgba(255, 255, 255, 0.035)";
    context.lineWidth = 1;
    for (let line = 1; line < 6; line += 1) {
      const y = Math.floor((height * line) / 6);
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(width, y);
      context.stroke();
    }
    if (!analyser) {
      return;
    }
    if (!this.samples || this.samples.length !== analyser.fftSize) {
      this.samples = new Float32Array(analyser.fftSize);
    }
    analyser.getFloatTimeDomainData(this.samples);
    const center = height * 0.5;
    const gain = height * 0.42;
    const samplesPerPixel = Math.max(
      1,
      Math.floor(this.samples.length / width),
    );
    const top = new Path2D();
    const bottom = new Path2D();
    for (let x = 0; x < width; x += 1) {
      const start = Math.floor((x / width) * this.samples.length);
      const stop = Math.min(this.samples.length, start + samplesPerPixel);
      let minimum = 0;
      let maximum = 0;
      for (let index = start; index < stop; index += 1) {
        minimum = Math.min(minimum, this.samples[index]);
        maximum = Math.max(maximum, this.samples[index]);
      }
      const yTop = center - maximum * gain;
      const yBottom = center - minimum * gain;
      if (x === 0) {
        top.moveTo(x, yTop);
        bottom.moveTo(x, yBottom);
      } else {
        top.lineTo(x, yTop);
        bottom.lineTo(x, yBottom);
      }
    }
    const gradient = context.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, "rgba(25, 190, 164, 0.52)");
    gradient.addColorStop(0.5, "rgba(255, 255, 255, 0.08)");
    gradient.addColorStop(1, "rgba(201, 121, 32, 0.38)");
    context.strokeStyle = gradient;
    context.lineWidth = Math.max(1.25, window.devicePixelRatio || 1);
    context.stroke(top);
    context.strokeStyle = "rgba(237, 178, 92, 0.76)";
    context.stroke(bottom);
  }
}

class LoopRangeControl {
  constructor(surfaces, onChange) {
    this.surfaces = surfaces;
    this.onChange = onChange;
    this.active = false;
    this.start = 0.15;
    this.end = 0.85;
    this.duration = 1;
    this.dragging = null;

    for (const surface of surfaces) {
      this.bindHandle(surface, surface.start, "start");
      this.bindHandle(surface, surface.end, "end");
    }
    this.render();
  }

  get minimumSpan() {
    return clamp(0.5 / Math.max(this.duration, 0.5), 0.01, 0.12);
  }

  bindHandle(surface, handle, side) {
    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      this.dragging = side;
      handle.classList.add("is-dragging");
      handle.setPointerCapture(event.pointerId);
      this.updateFromPointer(event, surface, side);
    });
    handle.addEventListener("pointermove", (event) => {
      if (this.dragging === side) {
        this.updateFromPointer(event, surface, side);
      }
    });
    const finish = (event) => {
      if (this.dragging !== side) {
        return;
      }
      this.dragging = null;
      handle.classList.remove("is-dragging");
      if (handle.hasPointerCapture(event.pointerId)) {
        handle.releasePointerCapture(event.pointerId);
      }
    };
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
    handle.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight"].includes(event.key)) {
        return;
      }
      event.preventDefault();
      const direction = event.key === "ArrowLeft" ? -1 : 1;
      const step = event.shiftKey ? 0.01 : 0.0025;
      this.setBoundary(side, (side === "start" ? this.start : this.end) + direction * step);
    });
  }

  updateFromPointer(event, surface, side) {
    const rect = surface.overlay.getBoundingClientRect();
    const value = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    this.setBoundary(side, value);
  }

  setBoundary(side, value) {
    if (side === "start") {
      this.start = clamp(value, 0, this.end - this.minimumSpan);
    } else {
      this.end = clamp(value, this.start + this.minimumSpan, 1);
    }
    this.render();
    this.onChange(this.active, this.start, this.end);
  }

  setDuration(duration) {
    this.duration = Math.max(duration, 0.5);
    if (this.end - this.start < this.minimumSpan) {
      this.end = clamp(this.start + this.minimumSpan, 0, 1);
    }
    this.render();
  }

  setActive(active) {
    this.active = active;
    for (const surface of this.surfaces) {
      surface.overlay.classList.toggle("is-active", active);
    }
    this.render();
    this.onChange(this.active, this.start, this.end);
  }

  render() {
    const startPercent = this.start * 100;
    const endPercent = this.end * 100;
    const startSeconds = this.start * this.duration;
    const endSeconds = this.end * this.duration;
    for (const surface of this.surfaces) {
      surface.start.style.left = `${startPercent}%`;
      surface.end.style.left = `${endPercent}%`;
      surface.selection.style.left = `${startPercent}%`;
      surface.selection.style.width = `${endPercent - startPercent}%`;
      surface.start.setAttribute("aria-valuenow", startSeconds.toFixed(2));
      surface.start.setAttribute("aria-valuemax", this.duration.toFixed(2));
      surface.start.setAttribute(
        "aria-valuetext",
        `${startSeconds.toFixed(2)} seconds`,
      );
      surface.end.setAttribute("aria-valuenow", endSeconds.toFixed(2));
      surface.end.setAttribute("aria-valuemax", this.duration.toFixed(2));
      surface.end.setAttribute(
        "aria-valuetext",
        `${endSeconds.toFixed(2)} seconds`,
      );
    }
  }
}

const engine = new AudioEngine(selectedParameters());
const waveform = new WaveformScope(document.querySelector("#waveformCanvas"));
let loopStages = Array.from(document.querySelectorAll(".spectrogram-stage"));
if (loopStages.length === 0 && document.querySelector("#waveformStage")) {
  loopStages = [document.querySelector("#waveformStage")];
}
const loopRange = new LoopRangeControl(
  loopStages.map((stage) => {
    const overlay = stage.querySelector(".loop-overlay");
    return {
      stage,
      overlay,
      selection: overlay.querySelector(".loop-selection"),
      start: overlay.querySelector(".loop-handle-start"),
      end: overlay.querySelector(".loop-handle-end"),
    };
  }),
  (active, start, end) => {
    state.loopStart = start;
    state.loopEnd = end;
    engine.setLoop(active, start * engine.duration, end * engine.duration);
  },
);
const originalSpectrogram = new Spectrogram(
  document.querySelector("#originalSpectrogram"),
);
const processedSpectrogram = new Spectrogram(
  document.querySelector("#processedSpectrogram"),
);

function selectedParameters() {
  return valuesForLevels(state.levels);
}

function resetVisuals() {
  originalSpectrogram.setSource(DEMO_CONFIG.sampleRate, engine.duration);
  processedSpectrogram.setSource(DEMO_CONFIG.sampleRate, engine.duration);
  waveform.clear();
  loopRange.setDuration(engine.duration);
  state.lastVisualTime = 0;
  els.time.textContent = "0.00s";
  els.meter.textContent = "L 0.0  H 0.0";
  els.source.textContent = `${Math.round(DEMO_CONFIG.sampleRate / 1000)} kHz`;
}

function buildFileSelect() {
  els.file.replaceChildren();
  for (const sample of DEMO_CONFIG.samples) {
    const option = document.createElement("option");
    option.value = sample.id;
    option.textContent = sample.label;
    els.file.append(option);
  }
}

function buildControls() {
  els.controls.replaceChildren();
  for (const spec of DEMO_CONFIG.params) {
    const control = new SwitchControl(
      spec,
      state.levels[spec.id],
      (parameterId, level) => {
        state.levels[parameterId] = level;
        const version = engine.setParameters(selectedParameters());
        setStatus(`applying parameters (${version})`, 1);
      },
    );
    state.controls.set(spec.id, control);
    els.controls.append(control.root);
  }
}

function updateMeter(meter) {
  if (!meter) {
    els.meter.textContent = "L 0.0  H 0.0";
    return;
  }
  const transient = meter.transient ? " T" : "";
  const harmonic = meter.harmonic ? " Hm" : "";
  els.meter.textContent =
    `L ${meter.lowGainDb.toFixed(1)}  ` +
    `H ${meter.highGainDb.toFixed(1)}${transient}${harmonic}`;
}

function renderLoop() {
  const time = engine.currentTime;
  if (engine.playing && time < state.lastVisualTime - 0.5) {
    resetVisuals();
  }
  state.lastVisualTime = time;
  const meter = state.meter;
  originalSpectrogram.draw(engine.originalAnalyser, time);
  processedSpectrogram.draw(engine.processedAnalyser, time, meter);
  waveform.draw(engine.monitorAnalyser);
  els.time.textContent = `${time.toFixed(2)}s`;
  updateMeter(meter);
  requestAnimationFrame(renderLoop);
}

function handleProcessingError(error) {
  setStatus("setup failed");
  console.error(error);
}

async function loadAudio(arrayBuffer, label) {
  const version = ++state.loadVersion;
  engine.stop();
  els.power.classList.remove("is-live");
  els.power.textContent = "Play";
  els.power.disabled = true;
  state.meter = null;
  setStatus(`decoding ${label}`, 0);
  const decoded = await engine.decode(arrayBuffer);
  if (version !== state.loadVersion) {
    return;
  }
  state.sourceData = decoded;
  state.sourceLabel = label;
  await engine.setSource(decoded);
  engine.setLoop(
    state.loopActive,
    state.loopStart * engine.duration,
    state.loopEnd * engine.duration,
  );
  resetVisuals();
  engine.setParameters(selectedParameters());
  els.power.disabled = false;
  setStatus(`ready ${state.sourceLabel} · live 256-sample DSP`, 1);
}

async function loadBundledSample(sampleId) {
  const sample =
    DEMO_CONFIG.samples.find((candidate) => candidate.id === sampleId) ||
    DEMO_CONFIG.samples[0];
  setStatus(`loading ${sample.label}`, 0);
  const response = await fetch(sample.url);
  if (!response.ok) {
    throw new Error(`Could not load ${sample.label} (${response.status})`);
  }
  await loadAudio(await response.arrayBuffer(), sample.label);
}

els.power.addEventListener("click", async () => {
  try {
    if (engine.playing) {
      engine.stop();
      els.power.classList.remove("is-live");
      els.power.textContent = "Play";
      resetVisuals();
      setStatus(`ready ${state.sourceLabel}`, 1);
      return;
    }
    await engine.play();
    els.power.classList.add("is-live");
    els.power.textContent = "Stop";
    setStatus(`playing ${state.sourceLabel}`, 1);
  } catch (error) {
    setStatus("audio playback blocked");
    console.error(error);
  }
});

els.bypass.addEventListener("click", () => {
  state.bypass = !state.bypass;
  engine.setBypass(state.bypass);
  els.bypass.classList.toggle("is-bypassed", state.bypass);
  els.bypass.setAttribute("aria-pressed", String(state.bypass));
  els.bypass.textContent = state.bypass ? "Bypassed" : "Processed";
  els.waveformTitle.textContent = state.bypass
    ? "Bypassed waveform"
    : "Processed waveform";
  waveform.clear();
});

els.loop.addEventListener("click", () => {
  state.loopActive = !state.loopActive;
  loopRange.setActive(state.loopActive);
  els.loop.classList.toggle("is-active", state.loopActive);
  els.loop.setAttribute("aria-pressed", String(state.loopActive));
  setStatus(
    `${state.loopActive ? "loop active" : "loop inactive"} · ${(
      state.loopStart * engine.duration
    ).toFixed(1)}–${(state.loopEnd * engine.duration).toFixed(1)}s`,
    1,
  );
});

els.file.addEventListener("change", () => {
  if (els.file.value === "uploaded" && state.uploadedFile) {
    loadAudio(
      state.uploadedFile.arrayBuffer.slice(0),
      state.uploadedFile.label,
    ).catch(handleProcessingError);
    return;
  }
  loadBundledSample(els.file.value).catch(handleProcessingError);
});

els.upload.addEventListener("change", async () => {
  const [file] = els.upload.files;
  if (!file) {
    return;
  }
  let option = els.file.querySelector('option[value="uploaded"]');
  if (!option) {
    option = document.createElement("option");
    option.value = "uploaded";
    els.file.prepend(option);
  }
  option.textContent = `Uploaded: ${file.name}`;
  els.file.value = "uploaded";
  try {
    const arrayBuffer = await file.arrayBuffer();
    state.uploadedFile = { label: file.name, arrayBuffer };
    await loadAudio(arrayBuffer.slice(0), file.name);
  } catch (error) {
    handleProcessingError(error);
  } finally {
    els.upload.value = "";
  }
});

window.addEventListener("resize", resetVisuals);

engine.onMeter = (meter) => {
  state.meter = meter;
  engine.setReferenceGain(meter.referenceGain);
  const referenceDb = 20 * Math.log10(Math.max(meter.referenceGain, 1e-8));
  els.bypass.dataset.referenceGainDb = referenceDb.toFixed(1);
  els.bypass.title = `Dry reference gain: ${referenceDb.toFixed(1)} dB`;
};

engine.onParametersApplied = () => {
  setStatus(
    engine.playing
      ? `playing ${state.sourceLabel} · parameters live`
      : `ready ${state.sourceLabel} · parameters live`,
    1,
  );
};

async function initialize() {
  buildFileSelect();
  buildControls();
  resetVisuals();
  renderLoop();
  await loadBundledSample(DEMO_CONFIG.samples[0].id);
}

initialize().catch(handleProcessingError);
