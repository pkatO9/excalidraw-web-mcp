/**
 * Tier palette for generated diagrams.
 *
 * Diagrams are coloured by default rather than on request. A wall of black
 * outlines reads as undifferentiated; colour carries the structure, so the eye
 * can follow a flow without reading every label.
 *
 * Colour is assigned by LAYER, not per box. In a layered diagram the layers are
 * already the tiers — clients, gateway, services, data stores, externals fall
 * out top to bottom — so every box in a tier matches automatically, with
 * nothing required from the model. A box can still override its colour when
 * there is a reason to.
 *
 * Each tier pairs a pale fill with a saturated stroke, and the label takes the
 * stroke colour. Excalidraw's bound label is a separate element that defaults to
 * near-black, so without setting it explicitly a coloured box still reads as a
 * black component — which is exactly what it looked like before.
 *
 * Values are Excalidraw's own palette: index 1 for the fill, index 4 for the
 * stroke, so they match what the colour picker offers if someone edits by hand.
 */

export type TierColour = {
  name: string;
  backgroundColor: string;
  strokeColor: string;
};

export const TIER_PALETTE: TierColour[] = [
  { name: "blue", backgroundColor: "#a5d8ff", strokeColor: "#1971c2" },
  { name: "violet", backgroundColor: "#d0bfff", strokeColor: "#6741d9" },
  { name: "yellow", backgroundColor: "#ffec99", strokeColor: "#f08c00" },
  { name: "teal", backgroundColor: "#96f2d7", strokeColor: "#099268" },
  { name: "orange", backgroundColor: "#ffd8a8", strokeColor: "#e8590c" },
  { name: "green", backgroundColor: "#b2f2bb", strokeColor: "#2f9e44" },
  { name: "red", backgroundColor: "#ffc9c9", strokeColor: "#e03131" },
];

/** Colour for a layer, cycling once a diagram runs deeper than the palette. */
export const tierFor = (layer: number): TierColour =>
  TIER_PALETTE[Math.abs(layer) % TIER_PALETTE.length];

/**
 * Default for a box added on its own, where there is no layer to go by.
 *
 * It inherits from the nearest already-coloured box so that extending a
 * diagram stays coherent — adding a cache beside a teal database should not
 * produce a blue one. With nothing to inherit from it falls back to the first
 * tier, which is still deliberate rather than black.
 */
export const inheritTier = (
  neighbours: {
    x: number;
    y: number;
    strokeColor?: string;
    backgroundColor?: string;
  }[],
  at: { x: number; y: number },
): TierColour => {
  const coloured = neighbours.filter(
    (candidate) =>
      candidate.strokeColor &&
      TIER_PALETTE.some((tier) => tier.strokeColor === candidate.strokeColor),
  );

  if (coloured.length === 0) {
    return TIER_PALETTE[0];
  }

  let nearest = coloured[0];
  let best = Infinity;
  for (const candidate of coloured) {
    const distance = (candidate.x - at.x) ** 2 + (candidate.y - at.y) ** 2;
    if (distance < best) {
      best = distance;
      nearest = candidate;
    }
  }

  return (
    TIER_PALETTE.find((tier) => tier.strokeColor === nearest.strokeColor) ??
    TIER_PALETTE[0]
  );
};
