// Browser-safe shared DTO barrel (strictly type-only, zero runtime emit).
//
// Modularized by boundary:
//   - dto/core.ts    : core platform, document, unified job & protocol DTOs
//   - dto/fanqie.ts  : Fanqie serialized novel DTOs
//   - dto/toutiao.ts : Toutiao article & delivery DTOs

export type * from "./dto/core.ts";
export type * from "./dto/fanqie.ts";
export type * from "./dto/toutiao.ts";
