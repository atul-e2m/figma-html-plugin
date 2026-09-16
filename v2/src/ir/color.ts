/** Colour helpers shared by the extractor and the compiler. */
export interface RGBA { r: number; g: number; b: number; a?: number }

export function rgbaToCss(c: RGBA, opacity = 1): string {
  const r = Math.round(c.r * 255), g = Math.round(c.g * 255), b = Math.round(c.b * 255);
  const a = (c.a ?? 1) * opacity;
  if (a >= 0.999) {
    const hex = (v: number) => v.toString(16).padStart(2, "0");
    return `#${hex(r)}${hex(g)}${hex(b)}`;
  }
  return `rgba(${r}, ${g}, ${b}, ${Math.round(a * 1000) / 1000})`;
}

export const round2 = (n: number): number => Math.round(n * 100) / 100;
