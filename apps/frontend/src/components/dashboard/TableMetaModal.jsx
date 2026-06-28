import { useState } from "react";
import { updateTableMeta } from "../../api";
import { ZONE_ICON } from "../../lib/constants";
import { capitalize } from "../../lib/format";
import { Icon } from "../Icon";

// Manager-only editor for a table's display metadata (zone + description,
// migration 013). Reuses the menu-modal form styling so it matches the rest of
// the dashboard's edit dialogs without new CSS. Zone is a closed dropdown (the
// six zones that have an icon/badge); description is free text. Saving an empty
// value clears the field.
const ZONES = Object.keys(ZONE_ICON);

export function TableMetaModal({ table, onClose, onSaved }) {
  const [zone, setZone] = useState(table.zone ?? "");
  const [description, setDescription] = useState(table.description ?? "");
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await updateTableMeta(table.id, {
        zone: zone || null,
        description: description.trim() || null
      });
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
            <Icon name="edit" />
            Edit table {table.label}
          </h2>
          <button type="button" className="menu-modal-close" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        <div className="menu-modal-body">
          {error ? <div className="menu-error">{error}</div> : null}
          <label className="menu-field">
            <span>Zone</span>
            <select value={zone} onChange={(e) => setZone(e.target.value)}>
              <option value="">No zone</option>
              {ZONES.map((z) => (
                <option key={z} value={z}>
                  {capitalize(z)}
                </option>
              ))}
            </select>
          </label>
          <label className="menu-field">
            <span>Description</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              maxLength={200}
              placeholder="e.g. Window two-top overlooking the street"
            />
          </label>
        </div>
        <footer className="menu-modal-actions">
          <button type="button" className="kitchen-btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="kitchen-btn primary" disabled={saving}>
            <Icon name="check" />
            {saving ? "Saving…" : "Save"}
          </button>
        </footer>
      </form>
    </div>
  );
}
