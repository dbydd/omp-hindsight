/** 外部输入（配置、队列文件、HTTP 响应）的窄化入口，避免每处各写一份。 */

import type { ObservationScopes } from "./types.ts";

/** 普通对象：排除 null 与数组。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** observationScopes 的形状：非空的 scope 模式名，或非空的标签组列表。 */
export function isObservationScopes(value: unknown): value is ObservationScopes {
  if (typeof value === "string") return value.length > 0;
  return Array.isArray(value) && value.length > 0 && value.every((group) => isStringArray(group));
}
