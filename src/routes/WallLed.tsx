import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useI18n } from "../i18n";
import { PanicScreen, WallBanner, WallStateBadge, useWallFeed } from "../components/wallCommon";

interface WallPhoto { id: string; kind: string; createdAt: string; thumbUrl: string | null; cutoutUrl?: string | null }

// The LED backdrop wall: a fixed grid of cells behind a stage. Brand cells carry the event's
// identity; photo cells cycle through the approved feed. The layout is a PER-EVENT setting
// (law 5) read from wall_config — columns, rows, cycle speed, where the brand sits — with a
// sane default when an event has not configured one. Nothing here is hardcoded to a venue.
//
// Cutout cells are part of feature F but their content — background-removed cutouts — arrives
// with Phase 3's self-hosted removal. Until then a cutout cell renders the photo contained
// rather than cropped: an honest fallback, not a pretend cutout.

interface LedLayout {
  columns: number;
  rows: number;
  cycleSeconds: number;
  brandPattern: "none" | "corners" | "row";
  /** "row" renders the bottom row as cutout cells: background-removed figures when a photo
   *  has one, the contained photo when it does not — law 2's fallback made visible. */
  cutoutPattern: "none" | "row";
}

const DEFAULT_LAYOUT: LedLayout = {
  columns: 6, rows: 3, cycleSeconds: 8, brandPattern: "corners", cutoutPattern: "none",
};

function brandCellsFor(l: LedLayout): Set<number> {
  const last = l.columns * l.rows - 1;
  switch (l.brandPattern) {
    case "corners":
      return new Set([0, l.columns - 1, last - l.columns + 1, last]);
    case "row":
      return new Set(Array.from({ length: l.columns }, (_, i) => i));
    default:
      return new Set();
  }
}

export default function WallLed() {
  const { slug = "" } = useParams();
  const { t } = useI18n();
  const { data, event, stale, title, banner } =
    useWallFeed<WallPhoto[]>(slug, "wall.photos", `led:${slug}`, 5000);
  const [offset, setOffset] = useState(0);

  const layout: LedLayout = useMemo(() => {
    const raw = (event?.wall_config as { led?: Partial<LedLayout> } | null)?.led ?? {};
    return {
      columns: Math.min(12, Math.max(2, Number(raw.columns) || DEFAULT_LAYOUT.columns)),
      rows: Math.min(8, Math.max(1, Number(raw.rows) || DEFAULT_LAYOUT.rows)),
      cycleSeconds: Math.min(120, Math.max(2, Number(raw.cycleSeconds) || DEFAULT_LAYOUT.cycleSeconds)),
      brandPattern: (["none", "corners", "row"] as const).includes(raw.brandPattern as never)
        ? (raw.brandPattern as LedLayout["brandPattern"])
        : DEFAULT_LAYOUT.brandPattern,
      cutoutPattern: raw.cutoutPattern === "row" ? "row" : "none",
    };
  }, [event?.wall_config]);

  // The cycle. Advancing the offset re-deals the feed across the photo cells, so every photo
  // gets its time on the wall rather than only the newest N living there forever.
  useEffect(() => {
    const timer = setInterval(
      () => setOffset((o) => o + 1),
      layout.cycleSeconds * 1000,
    );
    return () => clearInterval(timer);
  }, [layout.cycleSeconds]);

  const photos = data ?? [];
  const brandCells = brandCellsFor(layout);
  const totalCells = layout.columns * layout.rows;
  const photoCellCount = totalCells - brandCells.size;

  if (event?.panic_brand_only) {
    return (
      <div className="wall">
        <WallBanner text={banner} color={event.brand_primary} />
        <PanicScreen event={event} title={title} />
        <WallStateBadge stale={stale} />
      </div>
    );
  }

  let photoSlot = 0;
  return (
    <div className="wall">
      <WallBanner text={banner} color={event?.brand_primary} />
      {photos.length === 0 ? (
        <div className="wall-empty">{t.wallEmpty}</div>
      ) : (
        <div
          className="wall-led"
          style={{ gridTemplateColumns: `repeat(${layout.columns}, 1fr)` }}
        >
          {Array.from({ length: totalCells }, (_, cell) => {
            if (brandCells.has(cell)) {
              return (
                <div key={cell} className="led-brand"
                     style={{ background: event?.brand_primary ?? "#111" }}>
                  {event?.brand_logo_url
                    ? <img src={event.brand_logo_url} alt=""
                           style={{ maxWidth: "70%", maxHeight: "70%", objectFit: "contain" }} />
                    : <span>{title || t.appName}</span>}
                </div>
              );
            }
            const slot = photoSlot++;
            const p = photos.length
              ? photos[(slot + offset * photoCellCount) % photos.length]
              : null;
            const bottomRow = cell >= totalCells - layout.columns;
            const asCutout = layout.cutoutPattern === "row" && bottomRow;
            const src = asCutout ? (p?.cutoutUrl ?? p?.thumbUrl) : p?.thumbUrl;
            return (
              <div key={cell} className={asCutout ? "led-photo led-cutout" : "led-photo"}>
                {src ? <img src={src} alt="" loading="lazy" /> : null}
              </div>
            );
          })}
        </div>
      )}
      <WallStateBadge frozen={event?.wall_frozen} stale={stale} />
    </div>
  );
}
