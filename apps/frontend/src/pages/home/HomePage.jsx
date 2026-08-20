import { useCallback, useEffect, useMemo, useState } from "react";

import { useAuth } from "../../auth";
import { getHomeSummary } from "../../api";
import { PRODUCTS, ownedProducts, unownedProducts } from "../../data/products";
import { DashboardShell } from "../dashboard/DashboardShell";
import { ProductTile } from "./ProductTile";
import { ServiceLine } from "./ServiceLine";

/**
 * The venue home page.
 *
 * Not a launcher. The question a manager opens this to answer at 6pm is "what is
 * happening in my venue", so tonight's service leads and the products hang off
 * it. A grid of tiles alone would not be worth a second visit.
 */

const REFRESH_MS = 60_000;

export function HomePage({ navigate }) {
  const { memberships, activeRestaurantId } = useAuth();
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const membership = useMemo(
    () => memberships.find((m) => m.restaurant_id === activeRestaurantId) ?? memberships[0],
    [memberships, activeRestaurantId]
  );
  const services = membership?.services ?? [];

  const load = useCallback(async () => {
    try {
      setSummary(await getHomeSummary());
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // Refresh while the tab is visible. A stale figure is worse than no figure —
    // an operator who catches it wrong once stops trusting the page.
    const id = setInterval(() => {
      if (!document.hidden) void load();
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const openProduct = useCallback(
    (product) => {
      if (product.route) navigate(product.route);
      else navigate(`/home?about=${product.id}`);
    },
    [navigate]
  );

  const owned = ownedProducts(services);
  const rest = unownedProducts(services);

  // A venue that has not finished setup has nothing to report yet. Point at the
  // one thing that changes that, rather than showing an empty grid.
  const needsSetup = owned.length === 0 && !loading && !error;

  const localTime = summary?.venue?.time_zone
    ? new Intl.DateTimeFormat("en-AU", {
        timeZone: summary.venue.time_zone,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      }).format(new Date())
    : "";

  return (
    <DashboardShell active="Home" navigate={navigate} path="/home">
      <div className="home-page">
        {error ? (
          <p className="home-error" role="alert">
            Tonight's numbers didn't load. <button type="button" className="link-button" onClick={load}>Try again</button>
          </p>
        ) : (
          <ServiceLine
            venueName={summary?.venue?.name ?? membership?.name ?? "your venue"}
            service={summary?.service ?? {}}
            localTime={localTime}
            loading={loading}
          />
        )}

        {needsSetup ? (
          <section className="home-setup">
            <h2>Finish setup to start taking bookings</h2>
            <p>Your phone line and menu need a few more details before Bella can answer.</p>
            <button type="button" className="primary-button" onClick={() => navigate("/onboarding")}>
              Continue setup
            </button>
          </section>
        ) : null}

        {owned.length > 0 ? (
          <section className="home-section">
            <h2 className="home-section-title">Your products</h2>
            <div className="product-grid">
              {owned.map((p) => (
                <ProductTile
                  key={p.id}
                  product={p}
                  service={summary?.service}
                  owned
                  onOpen={openProduct}
                />
              ))}
            </div>
          </section>
        ) : null}

        {rest.length > 0 ? (
          <section className="home-section home-section-quiet">
            <h2 className="home-section-title">More from Vox</h2>
            <div className="product-grid product-grid-quiet">
              {rest.map((p) => (
                <ProductTile key={p.id} product={p} owned={false} onOpen={openProduct} />
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </DashboardShell>
  );
}

export { PRODUCTS };
