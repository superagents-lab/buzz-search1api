// Draws a `search1api-results` block as cards. Everything in a block is untrusted text from a message: React
// escapes it, links are re-checked to be http(s) without credentials, and nothing is loaded from the network.
import { React } from "./react";
import { parseBlock, type Card } from "./render";

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function date(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

const isPlace = (card: Card) =>
  card.rating !== undefined || card.review_count !== undefined || card.address !== undefined || card.open_state !== undefined;

function Stars({ rating, reviews }: { rating?: number | undefined; reviews?: number | undefined }) {
  if (rating === undefined && reviews === undefined) return null;
  return (
    <span className="s1b-rating">
      {rating !== undefined && (
        <>
          <span aria-hidden="true">★</span> <strong>{rating.toFixed(1)}</strong>
        </>
      )}
      {reviews !== undefined && <span className="s1b-dim"> ({reviews.toLocaleString("en-US")} reviews)</span>}
    </span>
  );
}

function PlaceCard({ card, index }: { card: Card; index: number }) {
  return (
    <li className="s1b-card" data-kind="place">
      <div className="s1b-card-head">
        <span className="s1b-index">{index + 1}</span>
        <a className="s1b-title" href={card.url} target="_blank" rel="noopener noreferrer">
          {card.title}
        </a>
      </div>
      <div className="s1b-line">
        <Stars rating={card.rating} reviews={card.review_count} />
        {card.category && <span className="s1b-dim">{card.category}</span>}
        {card.price && <span className="s1b-dim">{card.price}</span>}
      </div>
      {card.address && <div className="s1b-line s1b-dim">{card.address}</div>}
      {card.open_state && <div className="s1b-line s1b-dim">{card.open_state}</div>}
      {card.text && <p className="s1b-text">{card.text}</p>}
      {(card.website || card.phone) && (
        <div className="s1b-line s1b-links">
          {card.website && (
            <a href={card.website} target="_blank" rel="noopener noreferrer">
              {host(card.website)}
            </a>
          )}
          {card.phone && <span className="s1b-dim">{card.phone}</span>}
        </div>
      )}
    </li>
  );
}

function SourceCard({ card, index }: { card: Card; index: number }) {
  const when = date(card.published_date);
  return (
    <li className="s1b-card" data-kind="source">
      <div className="s1b-line s1b-dim s1b-site">
        <span className="s1b-index">{index + 1}</span>
        <span>{card.source ?? host(card.url)}</span>
        {when && <span>· {when}</span>}
      </div>
      <a className="s1b-title" href={card.url} target="_blank" rel="noopener noreferrer">
        {card.title}
      </a>
      {card.text && <p className="s1b-text">{card.text}</p>}
    </li>
  );
}

export function ResultCards({ code }: { code: string; language: string }) {
  // A block that does not parse throws here, and Buzz shows the plain block in its place.
  const cards = React.useMemo(() => parseBlock(code), [code]);
  return (
    <section className="s1b-root s1b-results" aria-label={cards.title ?? "Search results"}>
      {cards.title && <div className="s1b-results-title">{cards.title}</div>}
      <ol className="s1b-cards">
        {cards.results.map((card, index) =>
          isPlace(card) ? <PlaceCard key={index} card={card} index={index} /> : <SourceCard key={index} card={card} index={index} />,
        )}
      </ol>
      <div className="s1b-results-foot s1b-dim">
        {cards.results.length} result{cards.results.length === 1 ? "" : "s"} · via Search1API
      </div>
    </section>
  );
}
