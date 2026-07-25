/* SVG text injection, ported from ultra-super-party-passport
   (passport/document/injectSvg.ts + textMetrics.ts). Replaces
   CHANGE_<field> placeholder text nodes; fits overflowing values via
   textLength. Browser-only (DOMParser). */

type FaceKey = "document" | "typewriter" | "official";

const FACE_FACTOR: Record<FaceKey, number> = {
  document: 0.56, // Plus Jakarta Sans 500
  typewriter: 0.6, // IBM Plex Mono, exact
  official: 0.56, // Plus Jakarta Sans
};

const estimateWidth = (value: string, fontSize: number, face: FaceKey) =>
  value.length * fontSize * FACE_FACTOR[face];

const PLACEHOLDER = /^CHANGE_[a-zA-Z]+$/;

export function injectSvg(rawSvg: string, values: Record<string, string>): string {
  const doc = new DOMParser().parseFromString(rawSvg, "image/svg+xml");
  if (doc.querySelector("parsererror")) {
    throw new Error("injectSvg: could not parse SVG source");
  }

  const leaves = Array.from(doc.querySelectorAll("text, tspan, textPath")).filter(
    (node) => node.children.length === 0
  );

  for (const node of leaves) {
    const content = node.textContent?.trim() ?? "";
    if (!PLACEHOLDER.test(content)) continue;

    const field = content.slice("CHANGE_".length);
    if (!(field in values)) {
      throw new Error(`injectSvg: no value provided for placeholder field "${field}"`);
    }
    const value = values[field];

    const host = node.closest("text") ?? node;
    const fontSize = Number(host.getAttribute("data-size") ?? 16);
    const face = (host.getAttribute("data-font") ?? "document") as FaceKey;

    /* wrapping slots (the belief text) break into tspans */
    const wrapWidth = host.getAttribute("data-wrap-width");
    if (wrapWidth && node.tagName !== "textPath") {
      const maxW = Number(wrapWidth);
      const words = value.split(/\s+/).filter(Boolean);
      const lines: string[] = [];
      let cur = "";
      for (const word of words) {
        const cand = cur ? `${cur} ${word}` : word;
        if (cur && estimateWidth(cand, fontSize, face) > maxW) {
          lines.push(cur);
          cur = word;
        } else {
          cur = cand;
        }
      }
      if (cur) lines.push(cur);
      const x = host.getAttribute("x") ?? "0";
      const lineHeight = host.getAttribute("data-line-height") ?? String(fontSize);
      node.textContent = "";
      (lines.length ? lines : [""]).forEach((line, i) => {
        const tspan = doc.createElementNS("http://www.w3.org/2000/svg", "tspan");
        tspan.setAttribute("x", x);
        tspan.setAttribute("dy", i === 0 ? "0" : lineHeight);
        tspan.textContent = line;
        node.appendChild(tspan);
      });
      continue;
    }

    node.textContent = value;

    const fitWidth = host.getAttribute("data-fit-width");
    if (fitWidth && node.tagName !== "textPath") {
      const overflows = estimateWidth(value, fontSize, face) > Number(fitWidth);
      if (overflows || host.getAttribute("data-fit-always") === "true") {
        host.setAttribute("textLength", fitWidth);
        host.setAttribute("lengthAdjust", "spacingAndGlyphs");
      }
    }
  }

  return new XMLSerializer().serializeToString(doc.documentElement);
}

/** Rewrite the root <svg> tag's attributes without touching content. */
export function withRootAttrs(
  svgMarkup: string,
  attrs: Record<string, string | number>
): string {
  const end = svgMarkup.indexOf(">");
  let tag = svgMarkup.slice(0, end);
  const rest = svgMarkup.slice(end);
  for (const name of Object.keys(attrs)) {
    tag = tag.replace(new RegExp(`\\s${name}="[^"]*"`), "");
  }
  const added = Object.entries(attrs)
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ");
  return `${tag} ${added}${rest}`;
}
