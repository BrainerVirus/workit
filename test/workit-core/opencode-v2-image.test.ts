import { expect, test } from "bun:test";
import { SUPPORT_MATRIX } from "@/packages/workit-core/src/core/support-matrix";
import { V2_IMAGE_DIGESTS, v2Image } from "@/test/opencode-v2/image";

// The opt-in OpenCode V2 harness runs the image pinned for opencode.current;
// this keeps the pin and the digest in step in every run of the suite.
test("Given opencode.current in the support matrix, Then the V2 harness has an image digest for that exact version", () => {
  const current = SUPPORT_MATRIX.opencode.current;
  expect(Object.keys(V2_IMAGE_DIGESTS)).toContain(current);
  expect(v2Image()).toBe(`ghcr.io/anomalyco/opencode@${V2_IMAGE_DIGESTS[current]}`);
});

test("Given a version without a recorded digest, Then the harness refuses to pick an image", () => {
  expect(() => v2Image("0.0.0")).toThrow(
    /no ghcr.io\/anomalyco\/opencode digest recorded for OpenCode 0.0.0/,
  );
});
