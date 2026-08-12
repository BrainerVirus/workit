import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Package-local asset root. Core modules resolve their static assets relative to
// their own package root (templates/, commands/, skills/, hygiene/). In the
// monorepo the source package keeps assets at the package root; packaged
// adapters ship the same content under an explicit `assets/` directory.
//
// The walk finds the nearest ancestor directory that owns a package.json, which
// is the package root for both the monorepo source (packages/<pkg>/src/core/…)
// and a bundled adapter entry (packages/<pkg>/dist/….js).
export const packageRoot = (): string => {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    const parent = path.dirname(dir);
    // ponytail: stop at the filesystem root even without an ancestor package.json,
    // so the upward walk can never loop forever.
    if (existsSync(path.join(dir, "package.json")) || parent === dir) return dir;
    dir = parent;
  }
};

export const assetRoot = (): string => {
  const root = packageRoot();
  const assets = path.join(root, "assets");
  return existsSync(assets) ? assets : root;
};
