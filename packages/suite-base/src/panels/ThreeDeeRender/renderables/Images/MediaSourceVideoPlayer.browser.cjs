// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC Team
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/
// Run from repository root: yarn node --test packages/suite-base/src/panels/ThreeDeeRender/renderables/Images/MediaSourceVideoPlayer.browser.cjs
// Requires an existing Chrome (CHROME_PATH) and FFmpeg with libx264. No server is started.
const { chromium } = require("@playwright/test");
const esbuild = require("esbuild");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

function accessUnits(data) {
  const starts = [];
  for (let i = 0; i < data.length - 4; i++) {
    const size =
      data[i] === 0 && data[i + 1] === 0
        ? data[i + 2] === 1
          ? 3
          : data[i + 2] === 0 && data[i + 3] === 1
            ? 4
            : 0
        : 0;
    if (size && (data[i + size] & 31) === 9) {
      starts.push(i);
      i += size;
    }
  }
  assert.ok(starts.length > 0, "fixture must contain access-unit delimiters");
  return starts.map((start, i) => Array.from(data.subarray(start, starts[i + 1] ?? data.length)));
}

for (const profile of ["baseline", "high"]) {
  test(`HTTP native H264 ${profile} I/P frames preserve source time, reset ownership and parameter changes`, {
    timeout: 90000,
  }, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lichtblick-http-h264-"));
    let browser;
    try {
      const stream = path.join(directory, "full.h264");
      execFileSync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=0xc82020:s=3840x2160:r=30:d=0.133333",
        "-f",
        "lavfi",
        "-i",
        "color=c=0x20c820:s=3840x2160:r=30:d=0.133333",
        "-f",
        "lavfi",
        "-i",
        "color=c=0x2020c8:s=3840x2160:r=30:d=0.133333",
        "-filter_complex",
        "[0:v][1:v][2:v]concat=n=3:v=1:a=0,drawbox=x=0:y=0:w=200:h=200:color=white:t=fill:enable='eq(mod(n,4),1)',drawbox=x=0:y=0:w=200:h=200:color=black:t=fill:enable='eq(mod(n,4),2)',drawbox=x=0:y=0:w=200:h=200:color=yellow:t=fill:enable='eq(mod(n,4),3)'",
        "-frames:v",
        "12",
        "-c:v",
        "libx264",
        "-threads",
        "2",
        "-preset",
        "veryfast",
        "-tune",
        "zerolatency",
        "-profile:v",
        profile,
        "-pix_fmt",
        "yuv420p",
        "-x264-params",
        "keyint=4:min-keyint=4:scenecut=0:aud=1",
        "-f",
        "h264",
        stream,
      ]);
      const changed = path.join(directory, "changed.h264");
      execFileSync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=0x20c820:s=640x360:r=30",
        "-frames:v",
        "1",
        "-c:v",
        "libx264",
        "-threads",
        "2",
        "-preset",
        "veryfast",
        "-tune",
        "zerolatency",
        "-profile:v",
        profile,
        "-pix_fmt",
        "yuv420p",
        "-x264-params",
        "aud=1",
        "-f",
        "h264",
        changed,
      ]);
      const longGop = path.join(directory, "long-gop.h264");
      execFileSync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=0x20c820:s=640x360:r=30",
        "-frames:v",
        "301",
        "-c:v",
        "libx264",
        "-threads",
        "2",
        "-preset",
        "ultrafast",
        "-tune",
        "zerolatency",
        "-profile:v",
        "baseline",
        "-pix_fmt",
        "yuv420p",
        "-x264-params",
        "keyint=600:min-keyint=600:scenecut=0:aud=1",
        "-f",
        "h264",
        longGop,
      ]);
      const source = path.join(__dirname, "MediaSourceVideoPlayer.ts");
      const parser = path.resolve(process.cwd(), "packages/den/video/h264/H264.ts");
      const bundle = path.join(directory, "probe.js");
      await esbuild.build({
        stdin: {
          contents: `import {MediaSourceVideoPlayer} from ${JSON.stringify(source)};
      import {H264} from ${JSON.stringify(parser)};globalThis.productionPlayerProbe={MediaSourceVideoPlayer,H264};`,
          resolveDir: process.cwd(),
        },
        outfile: bundle,
        bundle: true,
        format: "iife",
        platform: "browser",
        target: "chrome123",
        tsconfig: "tsconfig.json",
      });
      browser = await chromium.launch({
        executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
        headless: true,
        args: ["--no-sandbox"],
      });
      const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      // The URL is a real untrusted HTTP origin in Chromium. Interception supplies
      // only the empty document, avoiding a listener or any station mutation.
      await page.route("**/*", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><html><body></body></html>",
        }),
      );
      await page.goto("http://192.0.2.10:5174/decoder-test");
      await page.addScriptTag({ path: bundle });
      const result = await page.evaluate(
        async ({ frames, changedFrame, longFrames }) => {
          const check = (condition, message) => {
            if (!condition) {
              throw new Error(message);
            }
          };
          check(
            !isSecureContext && typeof VideoDecoder === "undefined",
            "test must exercise an HTTP origin without WebCodecs",
          );
          const { MediaSourceVideoPlayer, H264 } = globalThis.productionPlayerProbe;
          const originalCreate = URL.createObjectURL.bind(URL),
            originalRevoke = URL.revokeObjectURL.bind(URL);
          const urls = new Set();
          let created = 0,
            revoked = 0;
          URL.createObjectURL = (value) => {
            const url = originalCreate(value);
            urls.add(url);
            created++;
            return url;
          };
          URL.revokeObjectURL = (url) => {
            check(urls.delete(url), "unknown or twice-revoked URL");
            revoked++;
            originalRevoke(url);
          };
          const player = new MediaSourceVideoPlayer();
          const errors = [];
          player.on("error", (error) => errors.push(error.message));
          const first = new Uint8Array(frames[0]);
          const config = H264.ParseDecoderConfig(first);
          await player.init(config);
          const pixels = [];
          let keyframes = 0,
            deltaFrames = 0;
          for (let index = 0; index < frames.length; index++) {
            const data = new Uint8Array(frames[index]);
            const key = H264.IsKeyframe(data);
            if (key) {
              keyframes++;
            } else {
              deltaFrames++;
            }
            const timestamp = 1000000 + index * 40111;
            const frame = await player.decode(data, timestamp, key ? "key" : "delta");
            check(
              frame && frame.timestamp === timestamp,
              "exact source timestamp must survive native decode",
            );
            check(
              frame.displayWidth === 3840 && frame.displayHeight === 2160,
              "native frame must stay 4K",
            );
            const canvas = document.createElement("canvas");
            canvas.width = 3840;
            canvas.height = 2160;
            const context = canvas.getContext("2d");
            context.drawImage(frame, 0, 0);
            const pixel = Array.from(context.getImageData(100, 100, 1, 1).data);
            pixels.push(pixel);
            const channel = Math.floor(index / 4);
            const phase = index % 4;
            const correct =
              phase === 0
                ? pixel[channel] > 130 &&
                  pixel.every((value, c) => c >= 3 || c === channel || value < pixel[channel] / 2)
                : phase === 1
                  ? pixel.slice(0, 3).every((value) => value > 220)
                  : phase === 2
                    ? pixel.slice(0, 3).every((value) => value < 20)
                    : pixel[0] > 150 && pixel[1] > 150 && pixel[2] < 70;
            check(correct, "stale or wrong decoded picture at frame " + index);
            frame.close();
          }
          check(
            keyframes === 3 && deltaFrames === 9,
            "must decode across multiple GOPs and P frames",
          );
          const resized = await player.decode(new Uint8Array(changedFrame), 3000000, "key");
          check(
            resized && resized.displayWidth === 640 && resized.displayHeight === 360,
            "SPS/PPS changes must replace the MSE configuration: " +
              JSON.stringify({
                width: resized?.displayWidth,
                height: resized?.displayHeight,
                errors,
              }),
          );
          resized.close();
          player.resetForSeek();
          await player.init(config);
          const pending = player.decode(first, 4000000, "key");
          await Promise.resolve();
          player.resetForSeek();
          check((await pending) == undefined, "an in-flight prior epoch must never return a frame");
          await player.init(config);
          const reset = await player.decode(first, -5000, "key");
          check(
            reset && reset.timestamp === -5000 && reset.displayWidth === 3840,
            "reset must restart exactly at the new source time",
          );
          reset.close();
          let rejected;
          try {
            await player.decode(new Uint8Array([0, 0, 0, 1, 0x41, 0xa0]), 0, "delta");
          } catch (error) {
            rejected = error;
          }
          check(
            rejected && errors.length === 1 && errors[0].includes("B frames"),
            "unsupported B frame must fail explicitly",
          );
          const longKey = new Uint8Array(longFrames[0]);
          await player.init(H264.ParseDecoderConfig(longKey));
          let longGopFrames = 0,
            budgetRejected;
          for (let index = 0; index < longFrames.length; index++) {
            try {
              const decoded = await player.decode(
                new Uint8Array(longFrames[index]),
                index * 33333,
                index === 0 ? "key" : "delta",
              );
              check(
                decoded && decoded.timestamp === index * 33333,
                "long GOP must keep source time",
              );
              decoded.close();
              longGopFrames++;
            } catch (error) {
              budgetRejected = error;
              break;
            }
          }
          check(
            longGopFrames === 300 && budgetRejected && errors.at(-1).includes("budget"),
            "missing IDR must hit the bounded GOP frame limit",
          );
          await player.init(config);
          const recovered = await player.decode(first, 0, "key");
          check(
            recovered?.displayWidth === 3840,
            "a fresh IDR must recover after the GOP budget limit",
          );
          recovered.close();
          let bytesRejected;
          try {
            await player.decode(new Uint8Array(32 * 1024 * 1024 + 1), 1, "delta");
          } catch (error) {
            bytesRejected = error;
          }
          check(
            bytesRejected && errors.at(-1).includes("budget"),
            "oversized input must fail before allocating an MP4 segment",
          );
          player.close();
          check(
            urls.size === 0 && created === revoked,
            "all native buffers and object URLs must be released",
          );
          return {
            origin: location.origin,
            secure: isSecureContext,
            keyframes,
            deltaFrames,
            pixels,
            sourceTimestampStep: 40111,
            longGopFrames,
            changedDimensions: [640, 360],
            resetTimestamp: -5000,
            errors,
            created,
            revoked,
          };
        },
        {
          frames: accessUnits(await fs.readFile(stream)),
          changedFrame: accessUnits(await fs.readFile(changed))[0],
          longFrames: accessUnits(await fs.readFile(longGop)),
        },
      );
      console.log(JSON.stringify(result));
    } finally {
      await browser?.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
}
