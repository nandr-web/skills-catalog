// Can a picture be read on a phone? A README shows an SVG as an <img> no wider than the page: on a 390px-wide phone,
// GitHub's column leaves about 358px, so a picture wider than that shrinks, and its labels with it. Arithmetic, no
// browser: the smallest font size the picture's own stylesheet gives a class it uses, times the shrink, must stay at
// 9px or more (review V6.5).
import type { Problem } from './map.ts';

export const PHONE_COLUMN = 358;
export const MIN_PHONE_PX = 9;

/** The smallest font size (px) any text in the SVG can have: from the rules for classes it uses, and inline sizes. */
export function smallestFont(svg: string): number {
  const style = [...svg.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
  const body = svg.replace(/<style>[\s\S]*?<\/style>/g, '');
  const used = new Set([...body.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1]!.split(/\s+/)));
  const sizes: number[] = [];
  for (const [, selector, decl] of style.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const size = decl!.match(/font-size:\s*([\d.]+)px/) ?? decl!.match(/font:[^;]*?\b([\d.]+)px/);
    if (!size) continue;
    const classes = [...selector!.matchAll(/\.([\w-]+)/g)].map((m) => m[1]!);
    if (classes.some((c) => used.has(c))) sizes.push(Number(size[1]));
  }
  for (const m of body.matchAll(/font-size="([\d.]+)"|font-size:\s*([\d.]+)px/g)) sizes.push(Number(m[1] ?? m[2]));
  return Math.min(...sizes);
}

/** The picture's width, from its viewBox. */
export const viewBoxWidth = (svg: string) => Number(svg.match(/viewBox="[\d.-]+[\s,]+[\d.-]+[\s,]+([\d.]+)/)?.[1]);

/** Pictures wide by design, each with why: on a phone the README's picture opens the interactive map, which scrolls
 *  sideways at full size. Any other picture must read on a phone as it is. */
export const WIDE_BY_DESIGN: Record<string, string> = {
  'docs/pictures/map-architecture.svg': 'the architecture: three columns side by side (one machine, the core, AWS); the README links it to the interactive map',
  'docs/pictures/map-ports.svg': 'each port with what plugs in on either side; the README links it to the interactive map',
};

export function phoneProblems(path: string, svg: string): Problem[] {
  if (WIDE_BY_DESIGN[path]) return [];
  const w = viewBoxWidth(svg), font = smallestFont(svg);
  const px = font * Math.min(1, PHONE_COLUMN / w);
  return px >= MIN_PHONE_PX ? [] : [{
    rule: 'unreadable-on-phone',
    message: `${path} is ${w}px wide: on a phone (${PHONE_COLUMN}px) its ${font}px labels shrink to ${px.toFixed(1)}px (under ${MIN_PHONE_PX}px); make it narrower`,
  }];
}
