# Reef Recon Live Demo

A static, browser-only demonstration of the Reef Recon audio algorithm. It runs
on GitHub Pages, accepts local audio uploads, and processes them without sending
the file to a server.

## What is implemented

- 44.1 kHz mono browser processing in a Web Worker
- WebAssembly biquad filter banks approximating the C++ fourth-order filters
- spectral whitening, input AGC, low/mid/high level control
- transient-band and structured-spectrum detection
- detector-guided reconstruction and output limiting
- synchronized original/processed playback with bypass and crossfades
- original and processed spectrograms plus a live waveform
- the same four LOW/MED/HIGH parameters as the static demo

The processing order, bands, time constants, detector logic, and render equation
come from `reef-recon/src/processing/RealtimeProcessor.cpp`. Filter coefficients
are intentionally browser-friendly approximations rather than numerically
identical copies of the C++ IIR implementation.

## Development

```bash
npm install
npm run build
npm run serve
```

Open <http://localhost:4173>.

Run the WebAssembly unit tests and the headless Chrome end-to-end test:

```bash
npm test
```

The deployable site is entirely contained in `site/`.
