import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chromePath =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function waitForServer(url) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Static server did not start");
}

test(
  "the live demo streams, loops, updates, uploads, and bypasses",
  { timeout: 120000 },
  async () => {
    const server = spawn(
      "python3",
      ["-m", "http.server", "4173", "--directory", "site"],
      { cwd: root, stdio: "ignore" },
    );
    let browser;
    try {
      await waitForServer("http://127.0.0.1:4173/");
      browser = await chromium.launch({
        executablePath: chromePath,
        headless: true,
        args: ["--autoplay-policy=no-user-gesture-required"],
      });
      const page = await browser.newPage({
        viewport: { width: 1440, height: 900 },
      });
      const pageErrors = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.goto("http://127.0.0.1:4173/", {
        waitUntil: "networkidle",
      });

      await page.waitForFunction(
        () =>
          document
            .querySelector("#statusText")
            ?.textContent.includes("ready Reef 1"),
        null,
        { timeout: 60000 },
      );
      assert.equal(await page.locator(".switch-control").count(), 4);
      assert.equal(await page.locator("#powerButton").isEnabled(), true);
      assert.deepEqual(
        await page.locator(".switch-control legend").allTextContents(),
        [
          "Snapping Shrimp Suppression",
          "Low Frequency Suppression",
          "Transient Detection Sensitivity",
          "Harmonic Detection Sensitivity",
        ],
      );
      await page.locator('label[for="transient_threshold_db-high"]').click();
      assert.equal(
        await page
          .locator(".switch-control")
          .filter({ hasText: "Transient Detection Sensitivity" })
          .locator(".readout")
          .count(),
        0,
      );
      assert.equal(
        await page.locator("#transient_threshold_db-high").isChecked(),
        true,
      );
      await page.locator('label[for="harmonic_threshold_db-low"]').click();
      assert.equal(
        await page
          .locator(".switch-control")
          .filter({ hasText: "Harmonic Detection Sensitivity" })
          .locator(".readout")
          .count(),
        0,
      );
      assert.equal(
        await page.locator("#harmonic_threshold_db-low").isChecked(),
        true,
      );

      await page.locator("#powerButton").click();
      await page.waitForTimeout(400);
      assert.match(
        await page.locator("#powerButton").getAttribute("class"),
        /is-live/,
      );
      assert.notEqual(await page.locator("#timeReadout").textContent(), "0.00s");

      const changedAt = Date.now();
      await page.locator('label[for="high_suppression_db-high"]').click();
      await page.waitForFunction(
        () =>
          document
            .querySelector("#statusText")
            ?.textContent.includes("parameters live"),
        null,
        { timeout: 1000 },
      );
      assert.ok(Date.now() - changedAt < 1000);
      assert.doesNotMatch(
        await page.locator("#statusText").textContent(),
        /processing/i,
      );

      const stage = await page
        .locator("#waveformStage .loop-overlay")
        .boundingBox();
      assert.ok(stage);
      const startHandle = page.locator("#loopStartHandle");
      const endHandle = page.locator("#loopEndHandle");
      assert.doesNotMatch(
        await page
          .locator("#waveformStage .loop-overlay")
          .getAttribute("class"),
        /is-active/,
      );
      await startHandle.hover();
      await page.mouse.down();
      await page.mouse.move(stage.x + stage.width * 0.25, stage.y + stage.height / 2);
      await page.mouse.up();
      await endHandle.hover();
      await page.mouse.down();
      await page.mouse.move(stage.x + stage.width * 0.3, stage.y + stage.height / 2);
      await page.mouse.up();
      assert.match(await startHandle.getAttribute("style"), /25/);
      assert.match(await endHandle.getAttribute("style"), /30/);

      await page.locator("#loopButton").click();
      assert.equal(
        await page.locator("#loopButton").getAttribute("aria-pressed"),
        "true",
      );
      assert.match(
        await page
          .locator("#waveformStage .loop-overlay")
          .getAttribute("class"),
        /is-active/,
      );
      assert.match(
        await page
          .locator("#originalSpectrogramStage .loop-overlay")
          .getAttribute("class"),
        /is-active/,
      );
      const loopStart = Number(await startHandle.getAttribute("aria-valuenow"));
      const loopEnd = Number(await endHandle.getAttribute("aria-valuenow"));
      await page.waitForTimeout(2600);
      const loopedTime = Number(
        (await page.locator("#timeReadout").textContent()).replace("s", ""),
      );
      assert.ok(loopedTime >= loopStart && loopedTime < loopEnd);

      await page.locator("#uploadInput").setInputFiles(
        path.join(root, "site/assets/samples/dolphin.m4a"),
      );
      await page.waitForFunction(
        () =>
          document
            .querySelector("#statusText")
            ?.textContent.includes("ready dolphin.m4a"),
        null,
        { timeout: 60000 },
      );
      assert.match(
        await page.locator("#fileSelect option:checked").textContent(),
        /Uploaded: dolphin\.m4a/,
      );

      await page.locator("#powerButton").click();
      await page.waitForTimeout(700);
      assert.match(
        await page.locator("#powerButton").getAttribute("class"),
        /is-live/,
      );
      assert.notEqual(await page.locator("#timeReadout").textContent(), "0.00s");

      await page.locator("#bypassButton").click();
      assert.equal(
        await page.locator("#bypassButton").textContent(),
        "Bypassed",
      );
      assert.equal(
        await page.locator("#bypassButton").getAttribute("aria-pressed"),
        "true",
      );
      const referenceGainDb = Number(
        await page.locator("#bypassButton").getAttribute("data-reference-gain-db"),
      );
      assert.ok(Number.isFinite(referenceGainDb));
      assert.ok(referenceGainDb > -40 && referenceGainDb < 4);

      await mkdir(path.join(root, "test-results"), { recursive: true });
      await page.screenshot({
        path: path.join(root, "test-results/live-demo.png"),
        fullPage: true,
      });
      assert.deepEqual(pageErrors, []);
    } finally {
      await browser?.close();
      server.kill("SIGTERM");
    }
  },
);
