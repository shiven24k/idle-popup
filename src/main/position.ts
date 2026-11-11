export interface Rect { x: number; y: number; width: number; height: number }
export interface Size { width: number; height: number }
export interface Point { x: number; y: number }

/**
 * Nine-grid placement, without the centre. "Random cycle" means a shuffled bag:
 * every zone is used once before any repeats, and the same zone never lands
 * twice in a row. That feels varied without looking like it is hunting for a
 * spot.
 */
export type Zone =
  | "top-left" | "top-center" | "top-right"
  | "middle-left" | "middle-right"
  | "bottom-left" | "bottom-center" | "bottom-right";

export const ZONES: Zone[] = [
  "top-left", "top-center", "top-right",
  "middle-left", "middle-right",
  "bottom-left", "bottom-center", "bottom-right",
];

export interface Placement { x: number; y: number; zone: Zone }

/**
 * Big enough to actually read, small enough to stay a card instead of taking
 * over the screen. The box is square because the images are a mix of portrait,
 * square and landscape; `object-fit: contain` letterboxes them into it without
 * cropping. It scales with the display so it is not tiny on a laptop and not
 * overwhelming on a 4K monitor.
 */
export function popupSize(workArea: Size, scale = 1): Size {
  const side = Math.round(
    Math.min(
      780,
      Math.max(380, Math.min(workArea.width * 0.36, workArea.height * 0.48))
    ) * scale
  );
  return { width: side, height: side };
}

function shuffle<T>(items: T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function zoneCell(zone: Zone, area: Rect): Rect {
  const col = zone.endsWith("left") ? 0 : zone.endsWith("right") ? 2 : 1;
  const row = zone.startsWith("top") ? 0 : zone.startsWith("bottom") ? 2 : 1;
  return {
    x: area.x + col * (area.width / 3),
    y: area.y + row * (area.height / 3),
    width: area.width / 3,
    height: area.height / 3,
  };
}

function inside(point: Point, rect: Rect, pad = 0): boolean {
  return (
    point.x >= rect.x - pad && point.x <= rect.x + rect.width + pad &&
    point.y >= rect.y - pad && point.y <= rect.y + rect.height + pad
  );
}

/** Keeps the card on screen and never flush against an edge. */
function clampPosition(x: number, y: number, size: Size, area: Rect, margin: number) {
  const minX = area.x + margin;
  const minY = area.y + margin;
  const maxX = area.x + area.width - size.width - margin;
  const maxY = area.y + area.height - size.height - margin;
  return {
    x: Math.round(Math.min(Math.max(x, minX), Math.max(minX, maxX))),
    y: Math.round(Math.min(Math.max(y, minY), Math.max(minY, maxY))),
  };
}

export function createPlacer(): { next(area: Rect, size: Size, cursor?: Point): Placement } {
  let bag: Zone[] = [];
  let last: Zone | null = null;

  function draw(): Zone {
    if (bag.length === 0) {
      bag = shuffle(ZONES);
      // Avoid an immediate repeat across bag boundaries.
      if (bag[0] === last && bag.length > 1) {
        [bag[0], bag[bag.length - 1]] = [bag[bag.length - 1], bag[0]];
      }
    }
    last = bag.shift() as Zone;
    return last;
  }

  return {
    next(area, size, cursor) {
      const margin = Math.round(Math.min(48, Math.max(18, area.width * 0.018)));

      // Draw up to four times, skipping spots that would land under the mouse.
      let placed: { x: number; y: number; zone: Zone } | null = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        const zone = draw();
        const cell = zoneCell(zone, area);
        const slackX = Math.max(0, cell.width - size.width - margin * 2);
        const slackY = Math.max(0, cell.height - size.height - margin * 2);
        // Bias towards the outer corner of the cell so opposite zones feel
        // genuinely different, then add a little jitter.
        const col = zone.endsWith("left") ? 0 : zone.endsWith("right") ? 1 : 0.5;
        const row = zone.startsWith("top") ? 0 : zone.startsWith("bottom") ? 1 : 0.5;
        const jitterX = (Math.random() - 0.5) * 0.4;
        const jitterY = (Math.random() - 0.5) * 0.4;
        const x = cell.x + margin + slackX * (col + jitterX);
        const y = cell.y + margin + slackY * (row + jitterY);
        const pos = clampPosition(x, y, size, area, margin);
        const rect = { ...pos, width: size.width, height: size.height };

        placed = { ...pos, zone };
        if (!cursor || !inside(cursor, rect, 80)) break;
      }

      return placed as Placement;
    },
  };
}
