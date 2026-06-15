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
  "the live demo streams blocks, updates instantly, uploads, and bypasses",
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
        "Bypassed -20 dB",
      );
      assert.equal(
        await page.locator("#bypassButton").getAttribute("aria-pressed"),
        "true",
      );

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
