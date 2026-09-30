// SPDX-License-Identifier: MPL-2.0

import { embeddedViewCapture } from "@lichtblick/suite-base/components/EmbeddedViewCapture";

import type { AnyRendererSubscription, IRenderer } from "./IRenderer";
import { SceneExtension } from "./SceneExtension";
import { captureView } from "./captureView";

export class ViewCaptureExtension extends SceneExtension {
  public static extensionId = "xgc.ViewCapture";
  #unregister: (() => void) | undefined;
  #imageTopic: string | undefined;
  #hasImage = false;
  #disposed = false;
  readonly #lifetime = new AbortController();

  public constructor(renderer: IRenderer, panelId: string | undefined) {
    super(ViewCaptureExtension.extensionId, renderer);
    if (!panelId) return;
    this.#unregister = embeddedViewCapture.register({
      panelId,
      view: renderer.interfaceMode === "image" ? "ar" : "3d",
      capture: async (signal) => {
        if (this.#disposed) throw new Error("View was disposed");
        renderer.queueAnimationFrame(); renderer.animationFrame();
        if (renderer.interfaceMode === "image" && !this.#hasImage) throw new Error("AR camera image is not ready");
        const abort = new AbortController();
        const cancel = () => abort.abort();
        signal.addEventListener("abort", cancel, { once: true });
        this.#lifetime.signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted || this.#lifetime.signal.aborted) abort.abort();
        try { return await captureView(renderer, abort.signal); }
        finally {
          signal.removeEventListener("abort", cancel);
          this.#lifetime.signal.removeEventListener("abort", cancel);
        }
      },
    });
  }
  public override getSubscriptions(): readonly AnyRendererSubscription[] {
    const topic = this.renderer.interfaceMode === "image" ? this.renderer.config.imageMode.imageTopic : undefined;
    if (topic !== this.#imageTopic) { this.#imageTopic = topic; this.#hasImage = false; }
    return topic ? [{ type: "topic", topicName: topic, subscription: { shouldSubscribe: () => true, handler: () => { this.#hasImage = true; } } }] : [];
  }
  public override removeAllRenderables(): void {
    this.#hasImage = false;
    super.removeAllRenderables();
  }
  public override dispose(): void {
    this.#disposed = true; this.#lifetime.abort(); this.#unregister?.();
    super.dispose();
  }
}
