import { useCallback, useEffect, useMemo, useState } from "react";
import { activateTable, createTable, deactivateTable, deleteTable, listManagedTables, updateTableMeta } from "../../api";
import { Icon } from "../../components/Icon";
import { DashboardShell } from "./DashboardShell";

const ATTRIBUTE_PRESETS = [
  "window facing",
  "center",
  "roadside",
  "sea facing",
  "quiet",
  "booth",
  "private",
  "bar",
  "high chair friendly",
  "wheelchair accessible"
];

const EMPTY_FORM = {
  label: "",
  minCapacity: 1,
  maxCapacity: 2,
  zone: "",
  description: "",
  attributes: []
};

export function ManageTablesPage({ navigate, path }) {
  const [tables, setTables] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listManagedTables();
      setTables(data.tables ?? []);
    } catch (err) {
      setError(err.message ?? String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const activeTables = useMemo(() => tables.filter((table) => table.is_active), [tables]);
  const totalSeats = useMemo(
    () => activeTables.reduce((sum, table) => sum + Number(table.max_capacity ?? 0), 0),
    [activeTables]
  );
  const uniqueAttrs = useMemo(() => {
    const set = new Set();
    for (const table of activeTables) {
      for (const attr of table.attributes ?? []) set.add(attr);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [activeTables]);

  const handleDeactivate = async (table) => {
    if (!window.confirm(`Deactivate table ${table.label}? Existing bookings stay intact.`)) return;
    setError(null);
    try {
      await deactivateTable(table.id);
      await load();
    } catch (err) {
      setError(err.message ?? String(err));
    }
  };

  const handleActivate = async (table) => {
    if (!window.confirm(`Reactivate table ${table.label}? It will become available for bookings again.`)) return;
    setError(null);
    try {
      await activateTable(table.id);
      await load();
    } catch (err) {
      setError(err.message ?? String(err));
    }
  };

  const handleDelete = async (table) => {
    // The old wording said "past bookings stay in history", which understated it:
    // the FK is ON DELETE SET NULL, so FUTURE confirmed bookings are unassigned
    // too — and an unassigned booking drops out of the overlap guard (migration
    // 025 is `WHERE table_id IS NOT NULL`), so its seat becomes bookable again.
    if (
      !window.confirm(
        `Permanently delete table ${table.label}?\n\n` +
          `Every booking on it — including future ones — will be left with no table, ` +
          `which frees their seats to be booked again. Deactivate instead if the table ` +
          `is only temporarily out of service.`
      )
    )
      return;
    setError(null);
    try {
      await deleteTable(table.id);
      await load();
    } catch (err) {
      setError(err.message ?? String(err));
    }
  };

  return (
    <DashboardShell active="Manage Tables" navigate={navigate} path={path}>
      <header className="operational-header manage-tables-header">
        <div>
          <h1>Manage Tables</h1>
          <p>Create the table map Bella and staff use when allocating bookings.</p>
        </div>
        <button className="feed-action-btn primary" onClick={() => setEditing({ mode: "create", table: null })}>
          <Icon name="add" />
          Add table
        </button>
      </header>

      <section className="feed-summary-cards">
        <article className="feed-stat-card">
          <div className="feed-stat-top">
            <span className="feed-stat-label">Active Tables</span>
            <Icon name="table_restaurant" className="feed-stat-icon" />
          </div>
          <div className="feed-stat-bottom">
            <span className="feed-stat-value">{activeTables.length}</span>
            <span className="feed-stat-sub">Available for allocation</span>
          </div>
        </article>
        <article className="feed-stat-card">
          <div className="feed-stat-top">
            <span className="feed-stat-label">Seat Capacity</span>
            <Icon name="groups" className="feed-stat-icon" />
          </div>
          <div className="feed-stat-bottom">
            <span className="feed-stat-value">{totalSeats}</span>
            <span className="feed-stat-sub">Max covers across active tables</span>
          </div>
        </article>
        <article className="feed-stat-card">
          <div className="feed-stat-top">
            <span className="feed-stat-label">Attributes</span>
            <Icon name="sell" className="feed-stat-icon" />
          </div>
          <div className="feed-stat-bottom">
            <span className="feed-stat-value">{uniqueAttrs.length}</span>
            <span className="feed-stat-sub">Preference tags Bella can match</span>
          </div>
        </article>
      </section>

      <section className="feed-activity-card manage-tables-card">
        <div className="feed-activity-header">
          <h2>Table Map</h2>
          <button className="feed-action-btn" onClick={load}>
            <Icon name="refresh" />
            Refresh
          </button>
        </div>
        {error && <div className="menu-error">{error}</div>}
        {loading && tables.length === 0 ? (
          <div className="manage-tables-empty">Loading tables...</div>
        ) : tables.length === 0 ? (
          <div className="manage-tables-empty">No tables yet. Add your first table to start allocating bookings.</div>
        ) : (
          <div className="manage-tables-grid">
            {tables.map((table) => (
              <article key={table.id} className={`manage-table-card ${table.is_active ? "" : "is-inactive"}`}>
                <div className="manage-table-card-head">
                  <div>
                    <span className="manage-table-id">{table.label}</span>
                    <span className="manage-table-capacity">
                      <Icon name="group" />
                      {table.min_capacity}-{table.max_capacity}
                    </span>
                  </div>
                  <span className={`manage-table-state ${table.is_active ? "active" : "inactive"}`}>
                    {table.is_active ? "Active" : "Inactive"}
                  </span>
                </div>
                <div className="manage-table-meta">
                  {table.zone ? <span><Icon name="place" />{table.zone}</span> : <span><Icon name="place" />No location</span>}
                  {table.description ? <p>{table.description}</p> : <p className="muted">No description</p>}
                </div>
                <div className="manage-table-attrs">
                  {(table.attributes ?? []).length > 0 ? (
                    table.attributes.map((attr) => <span key={attr}>{attr}</span>)
                  ) : (
                    <span className="empty">No attributes</span>
                  )}
                </div>
                <div className="manage-table-actions">
                  {table.is_active && (
                    <>
                      <button className="kitchen-btn ghost" onClick={() => setEditing({ mode: "edit", table })}>
                        <Icon name="edit" />
                        Edit
                      </button>
                      <button className="kitchen-btn ghost warn" onClick={() => handleDeactivate(table)}>
                        <Icon name="block" />
                        Deactivate
                      </button>
                    </>
                  )}
                  {!table.is_active && (
                    <button className="kitchen-btn success" onClick={() => handleActivate(table)}>
                      <Icon name="check" />
                      Reactivate
                    </button>
                  )}
                  <button className="kitchen-btn danger" onClick={() => handleDelete(table)}>
                    <Icon name="delete" />
                    Delete
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {editing && (
        <TableFormModal
          mode={editing.mode}
          table={editing.table}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </DashboardShell>
  );
}

function toForm(table) {
  if (!table) return EMPTY_FORM;
  return {
    label: table.label ?? "",
    minCapacity: table.min_capacity ?? 1,
    maxCapacity: table.max_capacity ?? 2,
    zone: table.zone ?? "",
    description: table.description ?? "",
    attributes: table.attributes ?? []
  };
}

function TableFormModal({ mode, table, onClose, onSaved }) {
  const [form, setForm] = useState(() => toForm(table));
  const [customAttr, setCustomAttr] = useState("");
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const isCreate = mode === "create";

  const setField = (key, value) => setForm((current) => ({ ...current, [key]: value }));

  const toggleAttr = (attr) => {
    setForm((current) => {
      const exists = current.attributes.some((item) => item.toLowerCase() === attr.toLowerCase());
      return {
        ...current,
        attributes: exists
          ? current.attributes.filter((item) => item.toLowerCase() !== attr.toLowerCase())
          : [...current.attributes, attr]
      };
    });
  };

  const addCustomAttr = () => {
    const next = customAttr.trim().replace(/\s+/g, " ");
    if (!next) return;
    toggleAttr(next);
    setCustomAttr("");
  };

  const submit = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const payload = {
      label: form.label.trim(),
      minCapacity: Number(form.minCapacity),
      maxCapacity: Number(form.maxCapacity),
      zone: form.zone.trim() || null,
      description: form.description.trim() || null,
      attributes: form.attributes
    };
    try {
      if (isCreate) await createTable(payload);
      else await updateTableMeta(table.id, payload);
      onSaved();
    } catch (err) {
      setError(err.message ?? String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="menu-modal-backdrop" onClick={onClose}>
      <form className="menu-modal table-map-modal" onClick={(event) => event.stopPropagation()} onSubmit={submit}>
        <header className="menu-modal-head">
          <h2>
            <Icon name={isCreate ? "add" : "edit"} />
            {isCreate ? "Add table" : `Edit ${table.label}`}
          </h2>
          <button type="button" className="menu-modal-close" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        <div className="menu-modal-body">
          {error && <div className="menu-error">{error}</div>}
          <div className="table-form-grid">
            <label className="menu-field">
              <span>Table ID</span>
              <input value={form.label} onChange={(event) => setField("label", event.target.value)} placeholder="T1" required />
            </label>
            <label className="menu-field">
              <span>Min seats</span>
              <input type="number" min="1" max="50" value={form.minCapacity} onChange={(event) => setField("minCapacity", event.target.value)} />
            </label>
            <label className="menu-field">
              <span>Max seats</span>
              <input type="number" min="1" max="50" value={form.maxCapacity} onChange={(event) => setField("maxCapacity", event.target.value)} />
            </label>
          </div>
          <label className="menu-field">
            <span>Location</span>
            <input value={form.zone} onChange={(event) => setField("zone", event.target.value)} placeholder="window, center, roadside, sea facing" />
          </label>
          <label className="menu-field">
            <span>Description</span>
            <textarea value={form.description} onChange={(event) => setField("description", event.target.value)} rows={2} maxLength={200} placeholder="Window four-top near the entry, quieter than main floor" />
          </label>
          <div className="menu-field">
            <span>Attributes</span>
            <div className="table-attr-picker">
              {ATTRIBUTE_PRESETS.map((attr) => {
                const selected = form.attributes.some((item) => item.toLowerCase() === attr.toLowerCase());
                return (
                  <button key={attr} type="button" className={selected ? "selected" : ""} onClick={() => toggleAttr(attr)}>
                    {attr}
                  </button>
                );
              })}
            </div>
            <div className="table-custom-attr">
              <input value={customAttr} onChange={(event) => setCustomAttr(event.target.value)} placeholder="Add custom attribute" />
              <button type="button" className="kitchen-btn ghost" onClick={addCustomAttr}>
                Add
              </button>
            </div>
          </div>
        </div>
        <footer className="menu-modal-actions">
          <button type="button" className="kitchen-btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="kitchen-btn primary" disabled={saving}>
            <Icon name="check" />
            {saving ? "Saving..." : "Save table"}
          </button>
        </footer>
      </form>
    </div>
  );
}
