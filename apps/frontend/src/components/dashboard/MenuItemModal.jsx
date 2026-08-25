import { useState } from "react";
import { createMenuItem, updateMenuItem } from "../../api";
import { Icon } from "../Icon";

export function MenuItemModal({ mode, item, presetCategoryId, categories, onClose, onSaved }) {
  const [name, setName] = useState(item?.name ?? "");
  const [description, setDescription] = useState(item?.description ?? "");
  const [priceDollars, setPriceDollars] = useState(((item?.base_price_cents ?? 0) / 100).toFixed(2));
  const [categoryId, setCategoryId] = useState(item?.category_id ?? presetCategoryId ?? categories[0]?.id ?? "");
  const [variants, setVariants] = useState(item?.variants?.map((v) => ({
    name: v.name,
    delta: (v.price_delta_cents / 100).toFixed(2)
  })) ?? []);
  // TIME columns come back as "HH:MM:SS"; the inputs (and the API's
  // timeSchema) speak "HH:MM".
  const [availableFrom, setAvailableFrom] = useState(item?.available_from?.slice(0, 5) ?? "");
  const [availableUntil, setAvailableUntil] = useState(item?.available_until?.slice(0, 5) ?? "");
  const [isRestricted, setIsRestricted] = useState(item?.is_restricted ?? false);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const addVariant = () => setVariants((vs) => [...vs, { name: "", delta: "0.00" }]);
  const removeVariant = (idx) => setVariants((vs) => vs.filter((_, i) => i !== idx));

  const handleSubmit = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const toCents = (raw) => {
        const n = parseFloat(raw ?? "0");
        return Number.isFinite(n) ? Math.round(n * 100) : 0;
      };
      const payload = {
        category_id: categoryId,
        name: name.trim(),
        description: description.trim() || null,
        base_price_cents: toCents(priceDollars),
        // Empty input = explicit null = clear back to all-day. The PATCH
        // route treats an absent key as "keep", so always send both.
        available_from: availableFrom || null,
        available_until: availableUntil || null,
        is_restricted: isRestricted,
        variants: variants
          .filter((v) => v.name.trim())
          .map((v, idx) => ({
            name: v.name.trim(),
            price_delta_cents: toCents(v.delta),
            display_order: idx
          }))
      };
      if (mode === "create") {
        await createMenuItem(payload);
      } else {
        await updateMenuItem(item.id, payload);
      }
      onSaved();
    } catch (e) {
      setError(e.message ?? "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="menu-modal-backdrop" onClick={onClose}>
      <form className="menu-modal" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
        <header className="menu-modal-head">
          <h2>
            <Icon name={mode === "create" ? "restaurant_menu" : "edit"} />
            {mode === "create" ? "New menu item" : `Edit ${item?.name}`}
          </h2>
          <button type="button" className="menu-modal-close" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        <div className="menu-modal-body">
          {error ? <div className="menu-error">{error}</div> : null}
          <label className="menu-field">
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} placeholder="e.g. Spaghetti Carbonara" />
          </label>
          <label className="menu-field">
            <span>Category</span>
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} required>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
          <label className="menu-field">
            <span>Description</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              maxLength={500}
              placeholder="Optional — guests see this on QR menus"
            />
          </label>
          <label className="menu-field">
            <span>Base price ($)</span>
            <input
              type="number"
              step="0.01"
              min="0"
              lang="en-US"
              inputMode="decimal"
              value={priceDollars}
              onChange={(e) => setPriceDollars(e.target.value)}
              required
            />
          </label>
          <div className="menu-field-row">
            <label className="menu-field">
              <span>Available from</span>
              <input
                type="time"
                value={availableFrom}
                onChange={(e) => setAvailableFrom(e.target.value)}
              />
            </label>
            <label className="menu-field">
              <span>Available until</span>
              <input
                type="time"
                value={availableUntil}
                onChange={(e) => setAvailableUntil(e.target.value)}
              />
            </label>
          </div>
          <p className="menu-variants-hint">
            {availableFrom || availableUntil ? (
              <>
                Voice orders only inside this daily window
                {availableFrom && availableUntil && availableFrom > availableUntil
                  ? " (overnight — spans midnight)"
                  : ""}
                .{" "}
                <button
                  type="button"
                  className="menu-link-btn"
                  onClick={() => {
                    setAvailableFrom("");
                    setAvailableUntil("");
                  }}
                >
                  Clear — available all day
                </button>
              </>
            ) : (
              "No window — available all day."
            )}
          </p>
          <label className="menu-field checkbox">
            <input
              type="checkbox"
              checked={isRestricted}
              onChange={(e) => setIsRestricted(e.target.checked)}
            />
            <span>Licensed item (18+) — staff can order it, the voice agent refuses it</span>
          </label>
          <div className="menu-variants-edit">
            <div className="menu-variants-head">
              <span>Variants (size tiers)</span>
              <button type="button" className="kitchen-btn ghost" onClick={addVariant}>
                <Icon name="add" />
                Variant
              </button>
            </div>
            {variants.length === 0 ? (
              <p className="menu-variants-hint">No variants yet — base price applies.</p>
            ) : (
              variants.map((v, idx) => (
                <div key={idx} className="menu-variant-row">
                  <input
                    placeholder="Name (e.g. Large)"
                    value={v.name}
                    onChange={(e) => setVariants((vs) => vs.map((x, i) => i === idx ? { ...x, name: e.target.value } : x))}
                  />
                  <input
                    type="number"
                    step="0.01"
                    lang="en-US"
                    inputMode="decimal"
                    placeholder="Δ$"
                    value={v.delta}
                    onChange={(e) => setVariants((vs) => vs.map((x, i) => i === idx ? { ...x, delta: e.target.value } : x))}
                  />
                  <button type="button" className="kitchen-btn danger" onClick={() => removeVariant(idx)} title="Remove variant">
                    <Icon name="close" />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
        <footer className="menu-modal-actions">
          <button type="button" className="kitchen-btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="kitchen-btn primary" disabled={saving}>
            <Icon name="check" />
            {saving ? "Saving…" : "Save"}
          </button>
        </footer>
      </form>
    </div>
  );
}
