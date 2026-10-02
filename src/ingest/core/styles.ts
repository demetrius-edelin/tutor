// A small reader for the CSS of an EPUB file. It finds the classes that make text bold,
// italic, or large. Many publishers use <p class="h1"> or <span class="b"> and not real tags.

export interface ClassStyle {
  bold?: boolean;
  italic?: boolean;
  // The font size relative to the normal text size, for example 2.6 for "2.6em".
  fontSize?: number;
}

export type StyleMap = Map<string, ClassStyle>;

const SIZE_KEYWORDS: Record<string, number> = {
  "xx-small": 0.6,
  "x-small": 0.75,
  small: 0.89,
  medium: 1,
  large: 1.2,
  "x-large": 1.5,
  "xx-large": 2,
  "xxx-large": 3,
  larger: 1.2,
  smaller: 0.83,
};

function parseSize(value: string): number | undefined {
  const keyword = SIZE_KEYWORDS[value.trim().toLowerCase()];
  if (keyword !== undefined) return keyword;
  const match = /(-?\d*\.?\d+)\s*(em|rem|%|px|pt)/i.exec(value);
  if (!match) return undefined;
  const number = Number(match[1]);
  switch (match[2]!.toLowerCase()) {
    case "%":
      return number / 100;
    case "px":
      return number / 16;
    case "pt":
      return number / 12;
    default:
      return number;
  }
}

export function parseDeclarations(text: string): ClassStyle {
  const style: ClassStyle = {};
  for (const declaration of text.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon < 0) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).replace(/!important/i, "").trim().toLowerCase();
    if (property === "font-weight") {
      style.bold = /bold|bolder/.test(value) || Number(value) >= 600;
    } else if (property === "font-style") {
      style.italic = /italic|oblique/.test(value);
    } else if (property === "font-size") {
      const size = parseSize(value);
      if (size !== undefined) style.fontSize = size;
    } else if (property === "font") {
      if (/\bbold\b|\b[6-9]00\b/.test(value)) style.bold = true;
      if (/\bitalic\b|\boblique\b/.test(value)) style.italic = true;
      const size = /(\d*\.?\d+(em|rem|%|px|pt))/.exec(value);
      if (size) style.fontSize = parseSize(size[1]!);
    }
  }
  return style;
}

// Read the rules with simple class selectors, for example ".h1" or "p.h1".
// A later rule for the same class overrides an earlier rule.
export function parseStylesheet(css: string, into: StyleMap = new Map()): StyleMap {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const style = parseDeclarations(match[2]!);
    if (Object.keys(style).length === 0) continue;
    for (const selector of match[1]!.split(",")) {
      const simple = /^[a-z0-9]*\.([\w-]+)$/i.exec(selector.trim());
      if (!simple) continue;
      const name = simple[1]!;
      into.set(name, { ...into.get(name), ...style });
    }
  }
  return into;
}

// The combined style of an element: its classes and its style attribute.
export function elementStyle(styles: StyleMap, className: string | undefined, inline: string | undefined): ClassStyle {
  const result: ClassStyle = {};
  for (const name of (className ?? "").split(/\s+/).filter(Boolean)) {
    const style = styles.get(name);
    if (!style) continue;
    if (style.bold !== undefined) result.bold = style.bold;
    if (style.italic !== undefined) result.italic = style.italic;
    if (style.fontSize !== undefined) result.fontSize = Math.max(result.fontSize ?? 0, style.fontSize);
  }
  if (inline) Object.assign(result, parseDeclarations(inline));
  return result;
}

export const HEADING_MIN_SIZE = 1.25;

// The heading level for each large font size: the largest size is level 1.
export function headingLevels(styles: StyleMap): Map<number, number> {
  const sizes = [...new Set([...styles.values()].map((style) => style.fontSize ?? 0))]
    .filter((size) => size >= HEADING_MIN_SIZE)
    .sort((a, b) => b - a);
  return new Map(sizes.map((size, i) => [size, Math.min(i + 1, 5)]));
}
