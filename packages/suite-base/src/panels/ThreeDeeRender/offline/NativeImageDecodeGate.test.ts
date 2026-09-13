// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import { NativeImageDecodeGate } from "./NativeImageDecodeGate";

const receipt = { imageTimeNs: 42n, width: 3840, height: 2160 };

describe("NativeImageDecodeGate", () => {
  it("waits for the submitted native image rather than an unrelated decode", async () => {
    const gate = new NativeImageDecodeGate();
    const epoch = gate.begin(42n);
    const pending = gate.wait(42n);
    gate.complete(epoch, receipt);
    await expect(pending).resolves.toEqual(receipt);
  });

  it("invalidates decoded and pending images when seeking", async () => {
    const gate = new NativeImageDecodeGate();
    const oldEpoch = gate.begin(42n);
    const old = gate.wait(42n);
    const rejected = expect(old).rejects.toThrow("superseded");
    const epoch = gate.begin(43n);
    await rejected;
    gate.complete(oldEpoch, receipt);
    const pending = gate.wait(43n);
    gate.complete(epoch, { ...receipt, imageTimeNs: 43n });
    await expect(pending).resolves.toMatchObject({ imageTimeNs: 43n });
  });

  it("rejects preview-resolution and error bitmaps rather than upscaling them", async () => {
    for (const size of [{ width: 1920, height: 1080 }, { width: 64, height: 64 }]) {
      const gate = new NativeImageDecodeGate();
      const epoch = gate.begin(42n);
      gate.complete(epoch, { ...receipt, ...size });
      await expect(gate.wait(42n)).rejects.toThrow("Native 4K");
    }
  });

  it("a decoder error cannot be turned into success by a later error-image callback", async () => {
    const gate = new NativeImageDecodeGate();
    const epoch = gate.begin(42n);
    gate.fail(epoch, new Error("Corrupt JPEG"));
    gate.complete(epoch, receipt);
    await expect(gate.wait(42n)).rejects.toThrow("Corrupt JPEG");
  });

  it("rejects missing and wrong source images", async () => {
    const gate = new NativeImageDecodeGate();
    await expect(gate.wait(42n)).rejects.toThrow("not submitted");
    const epoch = gate.begin(42n);
    gate.complete(epoch, { ...receipt, imageTimeNs: 41n });
    await expect(gate.wait(42n)).rejects.toThrow("timestamp");
  });

  it("abort and dispose reject in-flight work", async () => {
    const gate = new NativeImageDecodeGate();
    gate.begin(42n);
    const abort = new AbortController();
    const pending = gate.wait(42n, abort.signal);
    abort.abort();
    await expect(pending).rejects.toThrow("aborted");
    gate.begin(42n);
    const disposed = gate.wait(42n);
    gate.dispose();
    await expect(disposed).rejects.toThrow("disposed");
  });

  it("rejects a stalled decode without leaving a waiter behind", async () => {
    const gate = new NativeImageDecodeGate();
    gate.begin(42n);
    await expect(gate.wait(42n, undefined, 1)).rejects.toThrow("timed out");
    const epoch = gate.begin(43n);
    gate.complete(epoch, { ...receipt, imageTimeNs: 43n });
    await expect(gate.wait(43n)).resolves.toMatchObject({ imageTimeNs: 43n });
  });
});
