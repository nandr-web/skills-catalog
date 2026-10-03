// Types for the vendored diagram renderer (renderer.js; see scripts/vendor-renderer.ts). Only what qa/src/map uses.

/** A system-map spec as the renderer reads it (the renderer's own schema checks it in full). */
export type SystemMapSpec = {
  kind: 'system-map';
  title: string;
  question: string;
  views: { id: string; label: string; note?: string }[];
  flows: { id: string; label: string }[];
  [key: string]: unknown;
};

export type MapLayout = { view: string; width: number; height: number };
/** interactive: parts can be clicked; partLinks: a part with a page (`href`) is a link to it; legend: a flow's steps
 *  in words under it. */
export type DrawOptions = { mode?: 'standalone' | 'inline'; idPrefix?: string; interactive?: boolean; legend?: boolean; partLinks?: boolean };

export function parseSystemMap(input: unknown): { spec: SystemMapSpec; warnings: string[] };
export function layoutSystemMap(spec: SystemMapSpec, view: string): MapLayout;
export function drawSystemMap(spec: SystemMapSpec, layout: MapLayout, flow: number | undefined, opts?: DrawOptions): string;
export function mapWarnings(spec: SystemMapSpec, warnings: string[]): void;
export function buildSystemMapFrom(data: unknown, opts?: { static?: boolean; header?: string; css?: string }): Promise<{ html: string; warnings: string[] }>;
export const MAP_BUDGET: { parts: number; flows: number; steps: number; labelChars: number; width: number };
/** The drawings' stylesheet (classes d-…, variables --d-…), for a page that shows them inline. */
export function diagramCss(): string;
export const fonts: { sans: string; mono: string; cond: string; googleCss: string };
/** A drawing wider than its box scrolls sideways and says so: the wrapper, and the CSS for the widths used. */
export function wrapWide(svg: string): { html: string; width: number | undefined };
export function scrollHintCss(widths: number[]): string;
