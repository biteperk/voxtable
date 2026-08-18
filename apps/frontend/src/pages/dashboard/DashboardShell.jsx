import { useId, useRef } from "react";
import { useAuth } from "../../auth";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useDrawer } from "../../hooks/useDrawer";
import { useScrolled } from "../../hooks/useScrolled";
import { Icon } from "../../components/Icon";
import { RestaurantSwitcher } from "../../components/dashboard/RestaurantSwitcher";
import { SidebarUserButton } from "../../components/dashboard/SidebarUserButton";

export function DashboardShell({ active, children, navigate, path }) {
  const { user, hasMinRole, role, isPlatformAdmin } = useAuth();
  const isPhone = useMediaQuery("(max-width: 767px)");
  const burgerRef = useRef(null);
  const drawer = useDrawer({ pathname: path, triggerRef: burgerRef });
  const { scrolled, sentinelRef } = useScrolled();
  const drawerTitleId = useId();

  // Role-filtered sidebar items. Most are hierarchical (hasMinRole), but Kitchen
  // is orthogonal to front-of-house — a server must NOT see it (the route guard
  // bounces them on click), so Kitchen shows only for the kitchen role itself or
  // manager+. Mirrors the route guard in main.jsx.
  const allItems = [
    ["Live Tables", "table_restaurant", "/live-tables", () => hasMinRole("server")],
    ["Live Feed", "graphic_eq", "/live-feed", () => hasMinRole("server")],
    ["Booking Log", "menu_book", "/booking-log", () => hasMinRole("server")],
    ["Manage Tables", "event_seat", "/manage-tables", () => hasMinRole("manager")],
    ["Manage Menu", "restaurant_menu", "/manage-menu", () => hasMinRole("manager")],
    ["Kitchen", "soup_kitchen", "/kitchen-overview", () => role === "kitchen" || hasMinRole("manager")],
    ["Analytics", "query_stats", "/analytics", () => hasMinRole("manager")]
  ];

  const items = allItems.filter(([, , , canSee]) => canSee());

  const sidebarMarkup = (
    <aside
      className="sidebar analytics-sidebar"
      role={isPhone ? "dialog" : undefined}
      aria-modal={isPhone ? "true" : undefined}
      aria-labelledby={isPhone ? drawerTitleId : undefined}
    >
      <div className="sidebar-top">
        <h2 id={drawerTitleId} className="sr-only">
          Menu
        </h2>
        <button
          className="dashboard-brand"
          onClick={() => navigate("/")}
          aria-label="VoxTable home"
        >
          <img
            src="/brand/mark-light-on-dark.svg"
            alt=""
            className="brand-mark"
            width="36"
            height="36"
          />
          <span className="dashboard-brand-text">
            <strong>VoxTable</strong>
            <span>Restaurant AI Hub</span>
          </span>
        </button>
        <RestaurantSwitcher />
      </div>

      <nav className="side-links" aria-label="Primary">
        {items.map(([label, icon, route]) => {
          const isActive = active === label;
          const isPending = !route;

          return (
            <button
              key={label}
              type="button"
              className={`${isActive ? "active" : ""} ${isPending ? "pending" : ""}`.trim()}
              onClick={() => {
                if (route) {
                  navigate(route);
                }
              }}
              aria-disabled={isPending}
              aria-current={isActive ? "page" : undefined}
            >
              <Icon name={icon} fill={isActive} />
              <span>{label}</span>
            </button>
          );
        })}
      </nav>

      <div className="sidebar-bottom">
        {isPlatformAdmin && (
          <button
            className="settings-link"
            type="button"
            onClick={() => navigate("/admin")}
          >
            <Icon name="admin_panel_settings" />
            <span>Admin</span>
          </button>
        )}
        {hasMinRole("manager") && (
          <button
            className={`settings-link ${active === "Billing" ? "active" : ""}`}
            type="button"
            onClick={() => navigate("/billing")}
            aria-current={active === "Billing" ? "page" : undefined}
          >
            <Icon name="credit_card" fill={active === "Billing"} />
            <span>Billing</span>
          </button>
        )}

        <SidebarUserButton
          user={user}
          active={active === "Profile"}
          onClick={() => navigate("/profile")}
        />
      </div>
    </aside>
  );

  if (!isPhone) {
    return (
      <div className="dashboard-shell">
        {sidebarMarkup}
        <main className="dashboard-content">{children}</main>
      </div>
    );
  }

  // Phone: top bar + drawer + scrollable main
  const initial = (user?.displayName || user?.email || "?").trim().charAt(0).toUpperCase();
  return (
    <div className="mobile-shell">
      <a href="#mobile-main" className="skip-link">
        Skip to content
      </a>
      <header className={`mobile-topbar ${scrolled ? "is-scrolled" : ""}`}>
        <button
          ref={burgerRef}
          type="button"
          className="mobile-topbar-burger"
          aria-label={drawer.isOpen ? "Close menu" : "Open menu"}
          aria-expanded={drawer.isOpen}
          aria-controls="primary-drawer"
          onClick={drawer.toggle}
        >
          <Icon name="menu" />
        </button>
        <button
          type="button"
          className="mobile-topbar-brand"
          onClick={() => navigate("/")}
          aria-label="VoxTable home"
        >
          <img
            src="/brand/mark-light-on-dark.svg"
            alt=""
            width="28"
            height="28"
          />
          <span>{active || "VoxTable"}</span>
        </button>
        <button
          type="button"
          className="mobile-topbar-avatar"
          onClick={() => navigate("/profile")}
          aria-label={user?.email ? `Account · ${user.email}` : "Account"}
        >
          {user?.photoURL ? (
            <img src={user.photoURL} alt="" />
          ) : (
            <span aria-hidden="true">{initial}</span>
          )}
        </button>
      </header>

      <div ref={sentinelRef} aria-hidden="true" className="topbar-sentinel" />

      <div
        className={`drawer-backdrop ${drawer.isOpen ? "is-open" : ""}`}
        onClick={drawer.close}
        aria-hidden="true"
      />
      <div
        id="primary-drawer"
        className={`drawer ${drawer.isOpen ? "is-open" : ""}`}
        inert={!drawer.isOpen || undefined}
      >
        {sidebarMarkup}
      </div>

      <main
        id="mobile-main"
        className="dashboard-content mobile-main"
        inert={drawer.isOpen || undefined}
      >
        {children}
      </main>
    </div>
  );
}
