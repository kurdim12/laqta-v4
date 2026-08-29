import { useParams } from "react-router-dom";
import { useI18n } from "../i18n";
import { PanicScreen, WallBanner, WallStateBadge, useWallFeed } from "../components/wallCommon";

interface Cell { cellIndex: number; photoId: string; kind: string; thumbUrl: string | null }

// The lightbox wall: 28 physical boxes, 7 across, 4 down. The arrangement is a database table
// (wall_cells), so it survives a refresh, a power cut, and a second screen opening the same
// wall — this component renders the placement, it does not own it. Empty boxes glow in the
// event's brand colour rather than sitting black, because a physical lightbox with a dead
// cell looks broken to the room even when it is merely empty.

const CELLS = 28;

export default function WallLightbox() {
  const { slug = "" } = useParams();
  const { t } = useI18n();
  const { data, event, stale, title, banner } =
    useWallFeed<Cell[]>(slug, "wall.lightbox", `lightbox:${slug}`, 3000);

  if (event?.panic_brand_only) {
    return (
      <div className="wall">
        <WallBanner text={banner} color={event.brand_primary} />
        <PanicScreen event={event} title={title} />
        <WallStateBadge stale={stale} />
      </div>
    );
  }

  const byIndex = new Map((data ?? []).map((c) => [c.cellIndex, c]));

  return (
    <div className="wall">
      <WallBanner text={banner} color={event?.brand_primary} />
      {(data ?? []).length === 0 && !stale ? (
        <div className="wall-empty">{t.wallEmpty}</div>
      ) : (
        <div className="wall-lightbox">
          {Array.from({ length: CELLS }, (_, i) => {
            const cell = byIndex.get(i);
            return cell?.thumbUrl ? (
              <div key={i} className="lightbox-cell">
                <img src={cell.thumbUrl} alt="" loading="lazy" />
              </div>
            ) : (
              <div key={i} className="lightbox-cell lightbox-empty"
                   style={{ background: `${event?.brand_primary ?? "#222"}22`,
                            borderColor: `${event?.brand_primary ?? "#333"}55` }} />
            );
          })}
        </div>
      )}
      <WallStateBadge frozen={event?.wall_frozen} stale={stale} />
    </div>
  );
}
