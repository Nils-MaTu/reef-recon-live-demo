export const DEMO_CONFIG = {
  sampleRate: 44100,
  blockSize: 256,
  suppressedGainDb: -20,
  limiterCeilingDbfs: -1,
  outputGainDb: 8,
  crossfadeMs: 140,
  maxUploadMinutes: 12,
  params: [
    {
      id: "high_suppression_db",
      label: "Snapping Shrimp Suppression",
      unit: "dB",
      levels: { low: 0, med: 14, high: 36 },
    },
    {
      id: "low_suppression_db",
      label: "Low Frequency Suppression",
      unit: "dB",
      levels: { low: 0, med: 10, high: 36 },
    },
    {
      id: "transient_threshold_db",
      label: "Transient Detection Sensitivity",
      unit: "dB",
      levels: { low: 6, med: 4.5, high: 3 },
    },
    {
      id: "harmonic_threshold_db",
      label: "Harmonic Detection Sensitivity",
      unit: "dB",
      levels: { low: 14, med: 12, high: 9 },
    },
  ],
  defaultLevels: {
    high_suppression_db: "med",
    low_suppression_db: "med",
    transient_threshold_db: "med",
    harmonic_threshold_db: "med",
  },
  samples: [
    { id: "reef-1", label: "Reef 1", url: "./assets/samples/reef-1.m4a" },
    { id: "reef-2", label: "Reef 2", url: "./assets/samples/reef-2.m4a" },
    { id: "reef-3", label: "Reef 3", url: "./assets/samples/reef-3.m4a" },
    { id: "reef-4", label: "Reef 4", url: "./assets/samples/reef-4.m4a" },
    { id: "dolphin", label: "Dolphin", url: "./assets/samples/dolphin.m4a" },
    {
      id: "regulator",
      label: "Regulator noise",
      url: "./assets/samples/regulator-noise.m4a",
    },
  ],
};

export function valuesForLevels(levels) {
  return Object.fromEntries(
    DEMO_CONFIG.params.map((spec) => [spec.id, spec.levels[levels[spec.id]]]),
  );
}
