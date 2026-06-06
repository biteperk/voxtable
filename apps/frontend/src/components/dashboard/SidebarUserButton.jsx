import { Icon } from "../Icon";
import { restaurantImage } from "../../lib/constants";

// Sidebar footer button → opens the profile/account page. Shows the user's
// Google photo (or the fallback image) plus name/email.
export function SidebarUserButton({ user, active, onClick }) {
  return (
    <button
      className={`sidebar-user ${active ? "active" : ""}`}
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
    >
      <img src={user?.photoURL ?? restaurantImage} alt="" />
      <div>
        <strong>{user?.displayName ?? "User"}</strong>
        <span>{user?.email ?? ""}</span>
      </div>
      <Icon name="chevron_right" className="sidebar-user-chevron" />
    </button>
  );
}
