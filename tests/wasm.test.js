import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function loadCore() {
  const bytes = await readFile(
    new URL("../site/dsp-core.wasm", import.meta.url),
  );
  const { instance } = await WebAssembly.instantiate(bytes, {
    env: {
      abort() {
        throw new Error("WebAssembly aborted");
      },
    },
  });
  instance.exports.resetHeap();
  return instance.exports;
}

function allocate(exports, values) {
  const pointer = exports.allocFloat32(values.length);
  new Float32Array(exports.memory.buffer, pointer, values.length).set(values);
  return pointer;
}

test("cascade bank preserves samples with identity sections", async () => {
  const core = await loadCore();
  const input = new Float32Array([0, 0.25, -0.5, 0.75, -1, 1, 0.1, -0.1]);
  const coefficients = new Float32Array([
    1, 0, 0, 0, 0,
    1, 0, 0, 0, 0,
  ]);
  const inputPointer = allocate(core, input);
  const outputPointer = core.allocFloat32(input.length);
  const coefficientPointer = allocate(core, coefficients);
  const statePointer = core.allocFloat32(4);
  core.clearFloat32(statePointer, 4);

  core.processCascadeBank(
    inputPointer,
    outputPointer,
    input.length,
    1,
    coefficientPointer,
    statePointer,
  );
  const output = Array.from(
    new Float32Array(core.memory.buffer, outputPointer, input.length),
  );
  assert.deepEqual(output, Array.from(input));
});

test("detector mix and limiter follow the C++ render equation", async () => {
  const core = await loadCore();
  const controlledPointer = allocate(core, new Float32Array([1, 0.5]));
  const acousticPointer = allocate(core, new Float32Array([0.2, 0.1]));
  const acousticGainPointer = allocate(core, new Float32Array([1, 0.5]));
  const structuredPointer = allocate(core, new Float32Array([0.1, 0.2]));
  const structuredGainPointer = allocate(core, new Float32Array([1, 0]));
  const renderedPointer = core.allocFloat32(2);

  core.renderDetectorMix(
    controlledPointer,
    acousticPointer,
    acousticGainPointer,
    1,
    structuredPointer,
    structuredGainPointer,
    1,
    renderedPointer,
    2,
    0.1,
  );
  const rendered = new Float32Array(core.memory.buffer, renderedPointer, 2);
  assert.ok(Math.abs(rendered[0] - 0.37) < 1e-6);
  assert.ok(Math.abs(rendered[1] - 0.09) < 1e-6);

  const limiterInput = allocate(core, new Float32Array([2, -2]));
  const limiterOutput = core.allocFloat32(2);
  core.applyLimiter(limiterInput, limiterOutput, 2, 0.5, 0.5, 0.8);
  const limited = new Float32Array(core.memory.buffer, limiterOutput, 2);
  assert.ok(Math.abs(limited[0] - 0.8) < 1e-6);
  assert.ok(Math.abs(limited[1] + 0.8) < 1e-6);
});
