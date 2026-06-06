import { useCallback, useEffect, useState } from "react";
import {
  createMenuCategory,
  deleteMenuCategory,
  deleteMenuItem,
  getMenu,
  updateMenuItem
} from "../../api";
import { Icon } from "../../components/Icon";
import { DashboardShell } from "./DashboardShell";
import { MenuItemModal } from "../../components/dashboard/MenuItemModal";

export function ManageMenuPage({ navigate, path }) {
  const [menu, setMenu] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null);
  const [selectedCategoryId, setSelectedCategoryId] = useState("all");
  const [addingCategory, setAddingCategory] = useState(false);
  const [deletingCategory, setDeletingCategory] = useState(null);
  const [deletingItem, setDeletingItem] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const data = await getMenu();
      setMenu(data);
      setError(null);
    } catch (e) {
      setError(e.message ?? "Failed to load menu");
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (selectedCategoryId === "all") return;
    if (!menu?.categories?.length) return;
    const stillExists = menu.categories.some((c) => c.id === selectedCategoryId);
    if (!stillExists) setSelectedCategoryId("all");
  }, [menu, selectedCategoryId]);

  const handleToggleAvailability = async (item) => {
    setBusy(true);
    try {
      await updateMenuItem(item.id, { is_available: !item.is_available });
      await refresh();
    } catch (e) {
      setError(e.message ?? "Update failed");
    } finally {
      setBusy(false);
    }
  };

  const confirmDeleteItem = async (item) => {
    setBusy(true);
    try {
      await deleteMenuItem(item.id);
      await refresh();
      return true;
    } catch (e) {
      throw e;
    } finally {
      setBusy(false);
    }
  };

  const visibleCategories = menu?.categories
    ? selectedCategoryId === "all"
      ? menu.categories
      : menu.categories.filter((c) => c.id === selectedCategoryId)
    : [];
  const totalItems = menu?.categories?.reduce((sum, c) => sum + c.items.length, 0) ?? 0;
  const presetCategoryForNew = selectedCategoryId === "all" ? null : selectedCategoryId;

  return (
    <DashboardShell active="Manage Menu" navigate={navigate} path={path}>
      <header className="operational-header">
        <div>
          <h1>Manage Menu</h1>
          <p>Add, edit, and toggle availability. Changes are live to the kitchen instantly.</p>
        </div>
        <div className="menu-page-actions">
          <button type="button" className="kitchen-btn ghost" onClick={() => setAddingCategory(true)} disabled={busy}>
            <Icon name="add" />
            Category
          </button>
          <button
            type="button"
            className="kitchen-btn primary"
            onClick={() => setEditing({ mode: "create", categoryId: presetCategoryForNew })}
            disabled={busy || !menu?.categories?.length}
          >
            <Icon name="restaurant_menu" />
            New menu item
          </button>
        </div>
      </header>

      {error ? <div className="menu-error">{error}</div> : null}

      {!menu ? (
        <div className="menu-empty">Loading…</div>
      ) : menu.categories.length === 0 ? (
        <div className="menu-empty">
          <Icon name="restaurant_menu" />
          <p>No categories yet.</p>
          <button type="button" className="kitchen-btn primary" onClick={() => setAddingCategory(true)} disabled={busy}>
            <Icon name="add" />
            Add your first category
          </button>
        </div>
      ) : (
        <section className="menu-layout">
          <aside className="menu-sidebar">
            <div className="menu-sidebar-head">
              <span>Categories</span>
              <strong>{menu.categories.length}</strong>
            </div>
            <nav className="menu-sidebar-list">
              <button
                type="button"
                className={`menu-sidebar-item${selectedCategoryId === "all" ? " is-active" : ""}`}
                onClick={() => setSelectedCategoryId("all")}
              >
                <span className="menu-sidebar-name">All categories</span>
                <span className="menu-sidebar-count">{totalItems}</span>
              </button>
              {menu.categories.map((category) => (
                <button
                  key={category.id}
                  type="button"
                  className={`menu-sidebar-item${category.id === selectedCategoryId ? " is-active" : ""}`}
                  onClick={() => setSelectedCategoryId(category.id)}
                >
                  <span className="menu-sidebar-name">{category.name}</span>
                  <span className="menu-sidebar-count">{category.items.length}</span>
                </button>
              ))}
            </nav>
            <footer className="menu-sidebar-foot">
              <span>Total items</span>
              <strong>{totalItems}</strong>
            </footer>
          </aside>

          <article className="menu-detail">
            {visibleCategories.length === 0 ? null : (
              <>
                {selectedCategoryId !== "all" && visibleCategories[0] ? (
                  <header className="menu-detail-head">
                    <div>
                      <h2>{visibleCategories[0].name}</h2>
                      <span>
                        {visibleCategories[0].items.length} item{visibleCategories[0].items.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    <div className="menu-detail-head-actions">
                      <button
                        type="button"
                        className="kitchen-btn primary"
                        onClick={() => setEditing({ mode: "create", categoryId: visibleCategories[0].id })}
                        disabled={busy}
                      >
                        <Icon name="add" />
                        New item
                      </button>
                      <button
                        type="button"
                        className="kitchen-btn danger"
                        onClick={() => setDeletingCategory(visibleCategories[0])}
                        disabled={busy}
                        title="Delete category"
                        aria-label="Delete category"
                      >
                        <Icon name="delete" />
                      </button>
                    </div>
                  </header>
                ) : null}
                <div className="menu-categories-stack">
                  {visibleCategories.map((category) => (
                    <section key={category.id} className="menu-category-block">
                      {selectedCategoryId === "all" ? (
                        <header className="menu-category-block-head">
                          <h3>{category.name}</h3>
                          <span>
                            {category.items.length} item{category.items.length === 1 ? "" : "s"}
                          </span>
                        </header>
                      ) : null}
                      {category.items.length === 0 ? (
                        <div className="menu-empty inline">
                          <p>No items in this category yet.</p>
                        </div>
                      ) : (
                        <div className="menu-items-grid">
                          {category.items.map((item) => (
                            <article
                              key={item.id}
                              className={`menu-item-card${item.is_available ? "" : " unavailable"}`}
                            >
                              <header className="menu-item-head">
                                <div className="menu-item-title">
                                  <strong>{item.name}</strong>
                                  <span className={`menu-item-status${item.is_available ? "" : " out"}`}>
                                    <i />
                                    {item.is_available ? "Available" : "Sold out"}
                                  </span>
                                </div>
                                <div className="menu-item-price">${(item.base_price_cents / 100).toFixed(2)}</div>
                              </header>
                              {item.description ? (
                                <p className="menu-item-desc">{item.description}</p>
                              ) : null}
                              {item.variants.length > 0 ? (
                                <div className="menu-item-variants">
                                  {item.variants.map((v) => (
                                    <span key={v.id} className="menu-item-variant">
                                      {v.name} {v.price_delta_cents >= 0 ? "+" : ""}
                                      ${(v.price_delta_cents / 100).toFixed(2)}
                                    </span>
                                  ))}
                                </div>
                              ) : null}
                              {item.modifier_groups.length > 0 ? (
                                <div className="menu-item-modifiers">
                                  {item.modifier_groups.map((g) => (
                                    <div key={g.group_name} className="menu-item-modifier-group">
                                      <strong>{g.group_name}</strong>
                                      <span>
                                        ({g.group_min_select}–{g.group_max_select}):{" "}
                                        {g.options.map((o) => o.name).join(", ")}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              ) : null}
                              <footer className="menu-item-actions">
                                <button
                                  type="button"
                                  className={`kitchen-btn ghost${item.is_available ? "" : " warn"}`}
                                  onClick={() => handleToggleAvailability(item)}
                                  disabled={busy}
                                >
                                  <Icon name={item.is_available ? "remove_shopping_cart" : "check_circle"} />
                                  {item.is_available ? "Sell out" : "Restore"}
                                </button>
                                <button
                                  type="button"
                                  className="kitchen-btn ghost"
                                  onClick={() => setEditing({ mode: "edit", item, categoryId: category.id })}
                                  disabled={busy}
                                >
                                  <Icon name="edit" />
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  className="kitchen-btn danger"
                                  onClick={() => setDeletingItem(item)}
                                  disabled={busy}
                                  title="Delete"
                                >
                                  <Icon name="delete" />
                                </button>
                              </footer>
                            </article>
                          ))}
                        </div>
                      )}
                    </section>
                  ))}
                </div>
              </>
            )}
          </article>
        </section>
      )}

      {editing ? (
        <MenuItemModal
          mode={editing.mode}
          item={editing.item}
          presetCategoryId={editing.categoryId}
          categories={menu?.categories ?? []}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await refresh();
          }}
        />
      ) : null}

      {addingCategory ? (
        <CategoryModal
          onClose={() => setAddingCategory(false)}
          onSaved={async () => {
            setAddingCategory(false);
            await refresh();
          }}
        />
      ) : null}

      {deletingCategory ? (
        <DeleteCategoryModal
          category={deletingCategory}
          onClose={() => setDeletingCategory(null)}
          onDeleted={async () => {
            setDeletingCategory(null);
            setSelectedCategoryId("all");
            await refresh();
          }}
        />
      ) : null}

      {deletingItem ? (
        <DeleteItemModal
          item={deletingItem}
          onClose={() => setDeletingItem(null)}
          onDelete={async () => {
            await confirmDeleteItem(deletingItem);
            setDeletingItem(null);
          }}
        />
      ) : null}
    </DashboardShell>
  );
}

function DeleteItemModal({ item, onClose, onDelete }) {
  const [error, setError] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const handleConfirm = async (event) => {
    event.preventDefault();
    setDeleting(true);
    setError(null);
    try {
      await onDelete();
    } catch (e) {
      setError(e.message ?? "Delete failed");
      setDeleting(false);
    }
  };

  return (
    <div className="menu-modal-backdrop" onClick={onClose}>
      <form
        className="menu-modal menu-modal-sm"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleConfirm}
      >
        <header className="menu-modal-head">
          <h2>
            <Icon name="delete" />
            Delete menu item
          </h2>
          <button type="button" className="menu-modal-close" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        <div className="menu-modal-body">
          {error ? <div className="menu-error">{error}</div> : null}
          <div className="delete-item-preview">
            <div className="delete-item-preview-head">
              <strong>{item.name}</strong>
              <span>${(item.base_price_cents / 100).toFixed(2)}</span>
            </div>
            {item.description ? (
              <p className="delete-item-preview-desc">{item.description}</p>
            ) : null}
            {item.variants?.length > 0 ? (
              <div className="delete-item-preview-meta">
                <Icon name="tune" />
                {item.variants.length} variant{item.variants.length === 1 ? "" : "s"}
              </div>
            ) : null}
          </div>
          <p className="menu-modal-hint">
            Permanently delete this item from the menu. Past order history
            keeps a snapshot, so old receipts and analytics stay correct.
          </p>
        </div>
        <footer className="menu-modal-actions">
          <button type="button" className="kitchen-btn ghost" onClick={onClose} disabled={deleting}>
            Cancel
          </button>
          <button type="submit" className="kitchen-btn danger" disabled={deleting}>
            <Icon name="delete" />
            {deleting ? "Deleting…" : "Delete item"}
          </button>
        </footer>
      </form>
    </div>
  );
}

function DeleteCategoryModal({ category, onClose, onDeleted }) {
  const [error, setError] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const hasItems = (category?.items?.length ?? 0) > 0;

  const handleDelete = async () => {
    if (hasItems) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteMenuCategory(category.id);
      onDeleted();
    } catch (e) {
      setError(e.message ?? "Delete failed");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="menu-modal-backdrop" onClick={onClose}>
      <form
        className="menu-modal menu-modal-sm"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); handleDelete(); }}
      >
        <header className="menu-modal-head">
          <h2>
            <Icon name="delete" />
            Delete category
          </h2>
          <button type="button" className="menu-modal-close" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        <div className="menu-modal-body">
          {error ? <div className="menu-error">{error}</div> : null}
          {hasItems ? (
            <p className="menu-modal-hint menu-modal-warn">
              <strong>“{category.name}” has {category.items.length} item{category.items.length === 1 ? "" : "s"}.</strong>
              <br />
              Categories with items can't be deleted. Move or delete the items first, then come back.
            </p>
          ) : (
            <p className="menu-modal-hint">
              Permanently delete <strong>“{category.name}”</strong>? This can't be undone.
            </p>
          )}
        </div>
        <footer className="menu-modal-actions">
          <button type="button" className="kitchen-btn ghost" onClick={onClose}>
            {hasItems ? "Close" : "Cancel"}
          </button>
          {!hasItems ? (
            <button type="submit" className="kitchen-btn danger" disabled={deleting}>
              <Icon name="delete" />
              {deleting ? "Deleting…" : "Delete category"}
            </button>
          ) : null}
        </footer>
      </form>
    </div>
  );
}

function CategoryModal({ onClose, onSaved }) {
  const [name, setName] = useState("");
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await createMenuCategory({ name: name.trim() });
      onSaved();
    } catch (e) {
      setError(e.message ?? "Create failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="menu-modal-backdrop" onClick={onClose}>
      <form className="menu-modal menu-modal-sm" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
        <header className="menu-modal-head">
          <h2>
            <Icon name="add" />
            New category
          </h2>
          <button type="button" className="menu-modal-close" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        <div className="menu-modal-body">
          {error ? <div className="menu-error">{error}</div> : null}
          <label className="menu-field">
            <span>Category name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={120}
              autoFocus
              placeholder="e.g. Mains, Drinks, Specials"
            />
          </label>
          <p className="menu-modal-hint">
            Categories group items on the kitchen display and guest menus. You can add items right after.
          </p>
        </div>
        <footer className="menu-modal-actions">
          <button type="button" className="kitchen-btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="kitchen-btn primary" disabled={saving || !name.trim()}>
            <Icon name="check" />
            {saving ? "Creating…" : "Create category"}
          </button>
        </footer>
      </form>
    </div>
  );
}
