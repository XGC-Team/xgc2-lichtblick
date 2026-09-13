// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

export type NativeImageReceipt = {
  imageTimeNs: bigint;
  width: number;
  height: number;
};

/** A decode callback from another seek epoch cannot complete this output frame. */
export class NativeImageDecodeGate {
  #epoch = 0;
  #requestedTime: bigint | undefined;
  #decoded: NativeImageReceipt | undefined;
  #error: Error | undefined;
  #closed = false;
  #waiter:
    | { resolve: (receipt: NativeImageReceipt) => void; reject: (error: Error) => void }
    | undefined;

  public begin(imageTimeNs: bigint): number {
    if (this.#closed) {
      throw new Error("Offline image decoder is closed");
    }
    this.invalidate("Offline image was superseded before capture");
    this.#requestedTime = imageTimeNs;
    return this.#epoch;
  }

  public complete(epoch: number, receipt: NativeImageReceipt): void {
    if (this.#closed || epoch !== this.#epoch || this.#error) {
      return;
    }
    if (receipt.imageTimeNs !== this.#requestedTime) {
      this.fail(epoch, new Error("Decoded image timestamp does not match the submitted image"));
      return;
    }
    if (!Number.isSafeInteger(receipt.width) || !Number.isSafeInteger(receipt.height)
      || receipt.width < 3840 || receipt.height < 2160) {
      this.fail(epoch, new Error("Native 4K export requires at least 3840 by 2160 source pixels"));
      return;
    }
    this.#decoded = { ...receipt };
    this.#waiter?.resolve(this.#decoded);
  }

  public fail(epoch: number, error: Error): void {
    if (epoch !== this.#epoch || this.#closed) {
      return;
    }
    this.#error = error;
    this.#decoded = undefined;
    this.#waiter?.reject(error);
  }

  public wait(imageTimeNs: bigint, signal?: AbortSignal, timeoutMs = 30_000): Promise<NativeImageReceipt> {
    if (this.#closed) {
      return Promise.reject(new Error("Offline image decoder is closed"));
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) {
      return Promise.reject(new RangeError("Invalid offline decode timeout"));
    }
    if (signal?.aborted) {
      return Promise.reject(new Error("Offline image decode was aborted"));
    }
    if (imageTimeNs !== this.#requestedTime) {
      return Promise.reject(new Error("The expected source image was not submitted"));
    }
    if (this.#error) {
      return Promise.reject(this.#error);
    }
    if (this.#waiter) {
      return Promise.reject(new Error("Another capture is waiting for this image"));
    }
    if (this.#decoded) {
      return Promise.resolve({ ...this.#decoded });
    }
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer != undefined) {
          clearTimeout(timer);
        }
        signal?.removeEventListener("abort", onAbort);
        this.#waiter = undefined;
      };
      const fail = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onAbort = () => {
        this.invalidate("Offline image decode was aborted");
      };
      this.#waiter = {
        resolve: (receipt) => { cleanup(); resolve({ ...receipt }); },
        reject: fail,
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        this.invalidate("Offline image decode timed out");
      }, timeoutMs);
    });
  }

  public invalidate(reason: string): void {
    this.#epoch++;
    this.#requestedTime = undefined;
    this.#decoded = undefined;
    this.#error = undefined;
    this.#waiter?.reject(new Error(reason));
  }

  public dispose(): void {
    this.#closed = true;
    this.invalidate("Offline image decoder was disposed");
  }
}
