// The domain packages' public surface.
//
// Only the frozen parts of the contracts are re-exported. The two product
// domains never import each other, and neither imports Host or Client code; the
// shared mechanics live in `shared/` and are imported by name.

export * as sharedDomain from "./shared/index.ts";
export * as fanqie from "./fanqie/index.ts";
export * as toutiao from "./toutiao/index.ts";
