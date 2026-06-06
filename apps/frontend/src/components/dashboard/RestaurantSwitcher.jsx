import { useAuth } from "../../auth";

// Restaurant switcher — only shown when the signed-in user belongs to more than
// one restaurant. Changing the active restaurant persists the choice (so
// X-Restaurant-Id flips) and reloads so every page refetches scoped to it.
export function RestaurantSwitcher() {
  const { memberships, activeRestaurantId, setActiveRestaurant } = useAuth();
  if (!Array.isArray(memberships) || memberships.length <= 1) return null;
  const onChange = (event) => {
    const id = event.target.value;
    if (!id || id === activeRestaurantId) return;
    setActiveRestaurant(id);
    window.location.reload();
  };
  return (
    <div className="restaurant-switcher">
      <label className="sr-only" htmlFor="restaurant-switcher-select">
        Active restaurant
      </label>
      <select
        id="restaurant-switcher-select"
        value={activeRestaurantId ?? ""}
        onChange={onChange}
      >
        {memberships.map((m) => (
          <option key={m.restaurant_id} value={m.restaurant_id}>
            {m.name || m.restaurant_id}
          </option>
        ))}
      </select>
    </div>
  );
}
