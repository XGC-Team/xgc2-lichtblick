# Native offline image mode

Draft companion to the Experiment video-production panel. This is **not** a complete standalone bag-to-video exporter and is not installed into the live viewer defaults.

Baseline: `a617c783ac382a0d8366bc6b5cc4c420c1407fdc` (`xgc2`).

A dedicated offline Renderer can opt in with `nativeExportSceneExtensions(existingSceneExtensions)` and `interfaceMode: "image"`. The factory changes only that Renderer instance's image extension; the ordinary ImageMode and its intentional 1920 preview limit remain unchanged. Existing camera projection, Path/Marker/URDF rendering and source semantics are reused.

`NativeExportImageMode.waitForNativeImage(expectedImageTimeNs, signal)` waits for the independently decoded image, not only the existing video-decode queue. Decode failures cannot become success through the base class's error-image `onDecoded` callback. Decoded dimensions below 3840 × 2160 fail instead of being called native 4K. Seek epochs prevent an older callback from acknowledging a newer image.

Inter-frame video must be turned into an independently decodable frame by the trusted offline preparer, preserving its original image timestamp and mapping. This first implementation explicitly rejects codec video messages, because the live decoder can deliberately reuse the previous bitmap after recoverable errors. It must not claim that bitmap belongs to the requested output frame.

A full `FRAME_READY` server still has to restore the correct recorded scene, wait for TF/calibration/models/fonts, invoke the final renderer draw, check the actual drawing buffer dimensions, and wait for GPU completion. Image readiness alone is not scene/frame readiness. Do not attach this factory or a frame controller to the live GCS iframe, and do not mutate the default scene extension config.

Tests: `NativeImageDecodeGate.test.ts` is a colocated Jest suite for normal repository validation. A dependency-free TypeScript compilation plus seven direct Node assertions was also run during authoring; that is not a claim that the repository's Yarn/Jest, WebGL integration or real bag acceptance ran.
