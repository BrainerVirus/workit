// The OpenCode V2 harness image, pinned by digest per OpenCode version. The
// version is the support-matrix `current` pin, so moving that pin without
// adding its digest here fails the (non-Docker) image test in the normal
// suite, not only the opt-in harness (#935: the digest once stayed on 2.0.18
// while `current` said 2.3.2).
import { SUPPORT_MATRIX } from "@/packages/workit-core/src/core/support-matrix";

/** Index digests of ghcr.io/anomalyco/opencode, by version. */
export const V2_IMAGE_DIGESTS: Readonly<Record<string, string>> = {
  "2.3.2": "sha256:be07cc4afd6d668d91b77accf1bc4338c87b39fbacc0a61666eb003781015f5a",
};

/** The OpenCode version the pinned V2 image runs. */
export const V2_IMAGE_VERSION = SUPPORT_MATRIX.opencode.current;

/** The image for `version`, by digest; throws when no digest is recorded. */
export const v2Image = (version: string = V2_IMAGE_VERSION): string => {
  const digest = V2_IMAGE_DIGESTS[version];
  if (!digest)
    throw new Error(
      `no ghcr.io/anomalyco/opencode digest recorded for OpenCode ${version}: add it to V2_IMAGE_DIGESTS in test/opencode-v2/image.ts`,
    );
  return `ghcr.io/anomalyco/opencode@${digest}`;
};
