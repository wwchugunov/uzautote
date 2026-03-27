export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
