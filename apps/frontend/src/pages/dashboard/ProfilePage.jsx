import { useEffect, useState } from "react";
import { useAuth } from "../../auth";
import { signOutUser } from "../../firebase";
import {
  getRestaurantProfile,
  getStaffList,
  inviteStaff,
  setVoicePaused,
  submitSupportRequest,
  updateRestaurantProfile,
  updateStaffRole,
  removeStaffMember,
  revokeStaffInvite
} from "../../api";
import { Icon } from "../../components/Icon";
import { BrandMark } from "../../components/brand/BrandMark";
import { DashboardShell } from "./DashboardShell";
import { restaurantImage } from "../../lib/constants";

const ROLE_LABELS = {
  owner: "Owner",
  manager: "Manager",
  server: "Server",
  kitchen: "Kitchen",
  staff: "Staff"
};

const ROLE_COLORS = {
  owner: "var(--primary)",
  manager: "var(--primary-dim)",
  server: "var(--secondary-fixed)",
  kitchen: "var(--tertiary)",
  staff: "var(--on-surface-variant)"
};

const ROLE_ICONS = {
  manager: "shield_person",
  server: "room_service",
  kitchen: "soup_kitchen"
};

const ROLE_DESCRIPTIONS = {
  manager: "Full access — menu, analytics, billing & staff management",
  server: "Front-of-house — live feed, bookings & tables",
  kitchen: "Kitchen only — the order queue & status updates"
};

const ASSIGNABLE_ROLES = ["manager", "server", "kitchen"];
const MANAGER_INVITABLE_ROLES = ["server", "kitchen"];
const DAYS = [
  ["monday", "Monday"],
  ["tuesday", "Tuesday"],
  ["wednesday", "Wednesday"],
  ["thursday", "Thursday"],
  ["friday", "Friday"],
  ["saturday", "Saturday"],
  ["sunday", "Sunday"]
];

const DEFAULT_HOURS = {
  monday: [{ open: "17:00", close: "22:00" }],
  tuesday: [{ open: "17:00", close: "22:00" }],
  wednesday: [{ open: "17:00", close: "22:00" }],
  thursday: [{ open: "17:00", close: "22:00" }],
  friday: [{ open: "17:00", close: "23:00" }],
  saturday: [{ open: "12:00", close: "23:00" }],
  sunday: [{ open: "12:00", close: "21:00" }]
};

const AU_STATES = ["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"];

export function ProfilePage({ navigate }) {
  const { user, hasMinRole } = useAuth();
  const isManager = hasMinRole("manager");
  const isOwner = hasMinRole("owner");
  const [supportOpen, setSupportOpen] = useState(false);

  const handleSignOut = async () => {
    await signOutUser();
    navigate("/");
  };

  const signInMethods = [
    {
      id: "google",
      label: "Google",
      description: user?.email ?? "Connected via Google",
      brand: "google",
      connected: true,
      primary: true
    },
    {
      id: "apple",
      label: "Apple",
      description: "Sign in with your Apple ID",
      brand: "apple",
      connected: false,
      comingSoon: true
    },
    {
      id: "email",
      label: "Email & password",
      description: "Use a dedicated email and password",
      brand: "email",
      connected: false,
      comingSoon: true
    }
  ];

  return (
    <DashboardShell active="Profile" navigate={navigate}>
      <header className="operational-header">
        <div>
          <h1>My Profile</h1>
          <p>Manage your account and how you sign in to VoxTable.</p>
        </div>
      </header>

      <section className="profile-grid">
        <article className="profile-identity-card">
          <img
            className="profile-avatar"
            src={user?.photoURL ?? restaurantImage}
            alt=""
          />
          <div className="profile-identity-text">
            <strong>{user?.displayName ?? "User"}</strong>
            <span>{user?.email ?? ""}</span>
            <span className="profile-session-pill">
              <i className="profile-session-dot" />
              Active session — signed in with Google
            </span>
          </div>
        </article>

        <RestaurantProfileSection canEdit={isManager} onSupport={() => setSupportOpen(true)} />

        <article className="profile-card">
          <header>
            <h2>Sign-in methods</h2>
            <p>Choose how you want to access VoxTable. You can connect multiple providers.</p>
          </header>
          <ul className="signin-method-list">
            {signInMethods.map((m) => (
              <li key={m.id} className={`signin-method-row ${m.comingSoon ? "disabled" : ""}`}>
                <div className={`signin-method-icon brand-${m.brand}`}>
                  {m.brand === "email" ? <Icon name="mail" /> : <BrandMark brand={m.brand} />}
                </div>
                <div className="signin-method-text">
                  <strong>{m.label}</strong>
                  <span>{m.description}</span>
                </div>
                <div className="signin-method-action">
                  {m.connected && <span className="signin-pill active">Connected · Active</span>}
                  {m.comingSoon && <span className="signin-pill muted">Coming soon</span>}
                </div>
              </li>
            ))}
          </ul>
        </article>

        <article className="profile-card">
          <header>
            <h2>Account</h2>
            <p>Manage profile photo, name, and password through your Google account.</p>
          </header>
          <a
            className="profile-action-row"
            href="https://myaccount.google.com"
            target="_blank"
            rel="noopener noreferrer"
          >
            <Icon name="open_in_new" />
            <div>
              <strong>Manage Google Account</strong>
              <span>Update photo, name, password, and 2-factor settings</span>
            </div>
            <Icon name="chevron_right" className="profile-action-chevron" />
          </a>
          <button className="profile-action-row danger" type="button" onClick={handleSignOut}>
            <Icon name="logout" />
            <div>
              <strong>Sign out</strong>
              <span>End your session on this device</span>
            </div>
            <Icon name="chevron_right" className="profile-action-chevron" />
          </button>
        </article>

        {isManager && (
          <StaffManagementSection isOwner={isOwner} currentUserId={user?.uid} />
        )}
      </section>

      {supportOpen && <SupportModal onClose={() => setSupportOpen(false)} />}
    </DashboardShell>
  );
}

function normalizeOpeningHours(hours) {
  const source = hours && typeof hours === "object" ? hours : DEFAULT_HOURS;
  return DAYS.reduce((acc, [key]) => {
    const first = Array.isArray(source[key]) ? source[key][0] : null;
    acc[key] = {
      closed: !first,
      open: first?.open ?? DEFAULT_HOURS[key][0].open,
      close: first?.close ?? DEFAULT_HOURS[key][0].close
    };
    return acc;
  }, {});
}

function hoursFormToPayload(hours) {
  return DAYS.reduce((acc, [key]) => {
    const day = hours[key];
    acc[key] = day?.closed ? [] : [{ open: day.open, close: day.close }];
    return acc;
  }, {});
}

function formatHours(hours) {
  const normalized = normalizeOpeningHours(hours);
  return DAYS.map(([key, label]) => {
    const day = normalized[key];
    return {
      key,
      label,
      value: day.closed ? "Closed" : `${day.open}-${day.close}`,
      closed: day.closed
    };
  });
}

function RestaurantProfileSection({ canEdit, onSupport }) {
  const [profile, setProfile] = useState(null);
  const [form, setForm] = useState(null);
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [voicePausedAt, setVoicePausedAt] = useState(null);
  const [pauseBusy, setPauseBusy] = useState(false);

  const togglePause = async () => {
    const next = !voicePausedAt;
    setPauseBusy(true);
    setError(null);
    try {
      const res = await setVoicePaused(next);
      setVoicePausedAt(res.voice_paused_at ?? null);
      // Let the dashboard banner (and any other open tab) update immediately.
      window.dispatchEvent(
        new CustomEvent("voxtable:voice-paused-changed", { detail: { paused: Boolean(next) } })
      );
    } catch (e) {
      setError(e.message ?? "Couldn't change the phone line — please try again.");
    } finally {
      setPauseBusy(false);
    }
  };

  const loadProfile = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getRestaurantProfile();
      const p = data.profile ?? {};
      setProfile(p);
      setVoicePausedAt(p.voice_paused_at ?? null);
      setForm({
        name: p.name ?? "",
        restaurantId: p.id ?? "",
        owner_name: p.owner_name ?? "",
        contact_email: p.contact_email ?? "",
        existing_phone_number: p.existing_phone_number ?? "",
        address: p.address ?? "",
        suburb: p.suburb ?? "",
        state: p.state ?? "",
        postcode: p.postcode ?? "",
        timezone: p.timezone ?? "Australia/Sydney",
        booking_duration_minutes: p.booking_duration_minutes ?? 90,
        opening_hours: normalizeOpeningHours(p.opening_hours)
      });
    } catch (e) {
      setError(e.message ?? String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadProfile();
  }, []);

  const setField = (key) => (event) => {
    setForm((prev) => ({ ...prev, [key]: event.target.value }));
  };

  const setDay = (day, patch) => {
    setForm((prev) => ({
      ...prev,
      opening_hours: {
        ...prev.opening_hours,
        [day]: { ...prev.opening_hours[day], ...patch }
      }
    }));
  };

  const cancelEdit = () => {
    if (profile) {
      setForm({
        name: profile.name ?? "",
        restaurantId: profile.id ?? "",
        owner_name: profile.owner_name ?? "",
        contact_email: profile.contact_email ?? "",
        existing_phone_number: profile.existing_phone_number ?? "",
        address: profile.address ?? "",
        suburb: profile.suburb ?? "",
        state: profile.state ?? "",
        postcode: profile.postcode ?? "",
        timezone: profile.timezone ?? "Australia/Sydney",
        booking_duration_minutes: profile.booking_duration_minutes ?? 90,
        opening_hours: normalizeOpeningHours(profile.opening_hours)
      });
    }
    setEditing(false);
    setError(null);
  };

  const submit = async (event) => {
    event.preventDefault();
    if (!form || saving) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await updateRestaurantProfile({
        name: form.name.trim() || undefined,
        owner_name: form.owner_name.trim() || undefined,
        contact_email: form.contact_email.trim() || undefined,
        existing_phone_number: form.existing_phone_number.trim() || undefined,
        address: form.address.trim() || undefined,
        suburb: form.suburb.trim() || undefined,
        state: form.state || undefined,
        postcode: form.postcode.trim() || undefined,
        timezone: form.timezone.trim() || undefined,
        booking_duration_minutes: Number(form.booking_duration_minutes),
        opening_hours: hoursFormToPayload(form.opening_hours)
      });
      await loadProfile();
      setEditing(false);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1800);
    } catch (e) {
      setError(e.message ?? String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <article className="profile-card restaurant-profile-card">
      <header>
        <div className="profile-card-title-row">
          <div>
            <h2>Restaurant Profile</h2>
            <p>{loading ? "Loading restaurant details..." : profile?.name ?? "Restaurant details"}</p>
          </div>
          <div className="profile-card-actions">
            <button type="button" className="profile-small-btn" onClick={onSupport}>
              <Icon name="support_agent" />
              Support
            </button>
            {canEdit && !editing && (
              <button type="button" className="profile-small-btn primary" onClick={() => setEditing(true)} disabled={!form}>
                <Icon name="edit" />
                Edit
              </button>
            )}
          </div>
        </div>
      </header>

      {canEdit && !loading && (
        <div className={`voice-pause-control${voicePausedAt ? " paused" : ""}`}>
          <div className="voice-pause-copy">
            <Icon name={voicePausedAt ? "phone_disabled" : "phone_in_talk"} />
            <div>
              <strong>{voicePausedAt ? "Phone bookings are paused" : "Phone bookings are on"}</strong>
              <span>
                {voicePausedAt
                  ? "Callers hear that you're not taking phone bookings right now."
                  : "Bella is answering the phone and taking bookings."}
              </span>
            </div>
          </div>
          <button
            type="button"
            className={`kitchen-btn ghost${voicePausedAt ? "" : " warn"}`}
            onClick={togglePause}
            disabled={pauseBusy}
          >
            <Icon name={voicePausedAt ? "play_circle" : "pause_circle"} />
            {voicePausedAt ? "Resume phone bookings" : "Pause phone bookings"}
          </button>
        </div>
      )}

      {error && (
        <div className="staff-error">
          <Icon name="error" />
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)}>x</button>
        </div>
      )}
      {saved && <div className="profile-save-note"><Icon name="check_circle" /> Saved</div>}

      {loading || !form ? (
        <div className="staff-loading"><span>Loading profile...</span></div>
      ) : editing ? (
        <form className="restaurant-profile-form" onSubmit={submit}>
          <div className="restaurant-form-grid">
            <label className="profile-field">
              <span>Restaurant name</span>
              <input value={form.name} onChange={setField("name")} maxLength={120} required />
            </label>
            <label className="profile-field">
              <span>Restaurant ID</span>
              <input value={form.restaurantId} readOnly />
            </label>
            <label className="profile-field">
              <span>Owner name</span>
              <input value={form.owner_name} onChange={setField("owner_name")} maxLength={120} />
            </label>
            <label className="profile-field">
              <span>Contact email</span>
              <input type="email" value={form.contact_email} onChange={setField("contact_email")} maxLength={160} />
            </label>
            <label className="profile-field">
              <span>Phone number</span>
              <input value={form.existing_phone_number} onChange={setField("existing_phone_number")} maxLength={32} />
            </label>
            <label className="profile-field">
              <span>Timezone</span>
              <input value={form.timezone} onChange={setField("timezone")} maxLength={64} />
            </label>
            <label className="profile-field restaurant-field-wide">
              <span>Address</span>
              <input value={form.address} onChange={setField("address")} maxLength={200} />
            </label>
            <label className="profile-field">
              <span>Suburb</span>
              <input value={form.suburb} onChange={setField("suburb")} maxLength={80} />
            </label>
            <label className="profile-field">
              <span>State</span>
              <select value={form.state} onChange={setField("state")}>
                <option value="">-</option>
                {AU_STATES.map((state) => <option key={state} value={state}>{state}</option>)}
              </select>
            </label>
            <label className="profile-field">
              <span>Postcode</span>
              <input value={form.postcode} onChange={(e) => setForm((prev) => ({ ...prev, postcode: e.target.value.replace(/\D/g, "").slice(0, 4) }))} inputMode="numeric" maxLength={4} />
            </label>
            <label className="profile-field">
              <span>Booking duration</span>
              <input type="number" min={15} max={360} step={15} value={form.booking_duration_minutes} onChange={setField("booking_duration_minutes")} />
            </label>
          </div>

          <div className="hours-editor">
            <div className="hours-editor-head">
              <span>Opening hours</span>
            </div>
            {DAYS.map(([key, label]) => {
              const day = form.opening_hours[key];
              return (
                <div key={key} className={`hours-editor-row ${day.closed ? "is-closed" : ""}`}>
                  <label className="hours-day-toggle">
                    <input
                      type="checkbox"
                      checked={!day.closed}
                      onChange={(e) => setDay(key, { closed: !e.target.checked })}
                    />
                    <span>{label}</span>
                  </label>
                  <input type="time" value={day.open} disabled={day.closed} onChange={(e) => setDay(key, { open: e.target.value })} />
                  <input type="time" value={day.close} disabled={day.closed} onChange={(e) => setDay(key, { close: e.target.value })} />
                </div>
              );
            })}
          </div>

          <div className="profile-form-actions">
            <button type="button" className="modal-button ghost" onClick={cancelEdit} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="modal-button confirm" disabled={saving}>
              {saving ? "Saving..." : "Save restaurant"}
            </button>
          </div>
        </form>
      ) : (
        <>
          <dl className="restaurant-profile-details">
            <div>
              <dt>Restaurant ID</dt>
              <dd>{profile.id}</dd>
            </div>
            <div>
              <dt>Address</dt>
              <dd>{[profile.address, profile.suburb, profile.state, profile.postcode].filter(Boolean).join(", ") || "Not set"}</dd>
            </div>
            <div>
              <dt>Contact</dt>
              <dd>{profile.contact_email || "Not set"}{profile.existing_phone_number ? ` · ${profile.existing_phone_number}` : ""}</dd>
            </div>
            <div>
              <dt>Timezone</dt>
              <dd>{profile.timezone}</dd>
            </div>
            <div>
              <dt>Booking duration</dt>
              <dd>{profile.booking_duration_minutes ?? 90} minutes</dd>
            </div>
          </dl>
          <div className="opening-hours-list">
            {formatHours(profile.opening_hours).map((day) => (
              <div key={day.key} className={day.closed ? "is-closed" : ""}>
                <span>{day.label}</span>
                <strong>{day.value}</strong>
              </div>
            ))}
          </div>
        </>
      )}
    </article>
  );
}

function SupportModal({ onClose }) {
  const [form, setForm] = useState({
    category: "technical",
    subject: "",
    message: ""
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  const submit = async (event) => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await submitSupportRequest(form);
      setSuccess(result.support_request);
    } catch (e) {
      setError(e.message ?? String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="support-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div className="modal-card new-booking-modal">
        <header className="new-booking-head">
          <div>
            <h2 id="support-modal-title" className="modal-title">Contact support</h2>
            <p className="modal-description">Send restaurant and account details to the VoxTable team.</p>
          </div>
          <button type="button" className="new-booking-close" onClick={onClose} disabled={submitting} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>

        {success ? (
          <div className="staff-modal-success">
            <Icon name="check_circle" />
            <p>Support request received.</p>
            <div className="staff-invite-link-box"><code>{success.id}</code></div>
            <div className="modal-actions">
              <button type="button" className="modal-button confirm" onClick={onClose}>Done</button>
            </div>
          </div>
        ) : (
          <form className="new-booking-form" onSubmit={submit}>
            {error && (
              <div className="nb-error" role="alert">
                <Icon name="error_outline" />
                <div><p>{error}</p></div>
              </div>
            )}
            <label className="nb-field">
              <span>Category</span>
              <select value={form.category} onChange={(e) => setForm((prev) => ({ ...prev, category: e.target.value }))}>
                <option value="technical">Technical</option>
                <option value="booking">Booking</option>
                <option value="billing">Billing</option>
                <option value="account">Account</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label className="nb-field">
              <span>Subject</span>
              <input value={form.subject} onChange={(e) => setForm((prev) => ({ ...prev, subject: e.target.value }))} maxLength={120} required />
            </label>
            <label className="nb-field">
              <span>Details</span>
              <textarea value={form.message} onChange={(e) => setForm((prev) => ({ ...prev, message: e.target.value }))} rows={5} maxLength={2000} required />
            </label>
            <div className="modal-actions">
              <button type="button" className="modal-button ghost" onClick={onClose} disabled={submitting}>Cancel</button>
              <button type="submit" className="modal-button confirm" disabled={submitting}>
                {submitting ? "Sending..." : "Send request"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

// ─── Staff Management Section (right column of profile-grid) ────────────────

function StaffManagementSection({ isOwner, currentUserId }) {
  const [members, setMembers] = useState([]);
  const [pendingInvites, setPendingInvites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [actionLoading, setActionLoading] = useState(null);
  const [copiedToken, setCopiedToken] = useState(null);
  const [confirmAction, setConfirmAction] = useState(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  const loadStaff = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getStaffList();
      setMembers(data?.members ?? []);
      setPendingInvites(data?.pending_invites ?? []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadStaff();
  }, []);

  // Mirror the backend DELETE /api/staff/:userId rules so the UI exposes exactly
  // what the API grants: the owner and yourself can't be removed; removing a
  // manager requires owner; a manager can remove server/kitchen/staff. (This
  // section only renders for managers, so the base case is already manager+.)
  const canRemoveMember = (m) =>
    m.role !== "owner" &&
    m.user_id !== currentUserId &&
    (m.role === "manager" ? isOwner : true);

  const handleRoleChange = async (userId, newRole) => {
    setActionLoading(userId);
    try {
      await updateStaffRole(userId, newRole);
      await loadStaff();
    } catch (e) {
      setError(e.message);
    } finally {
      setActionLoading(null);
    }
  };

  const handleRemove = async (userId) => {
    await removeStaffMember(userId);
    await loadStaff();
  };

  const handleRevoke = async (inviteId) => {
    await revokeStaffInvite(inviteId);
    await loadStaff();
  };

  // Drives the shared ConfirmModal for destructive actions (revoke / remove):
  // the row buttons stage an action, this runs it with busy state + error
  // surfacing in one place.
  const runConfirm = async () => {
    if (!confirmAction) return;
    setConfirmBusy(true);
    try {
      await confirmAction.run();
      setConfirmAction(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setConfirmBusy(false);
    }
  };

  const handleCopyLink = (token) => {
    const url = `${window.location.origin}/invite?token=${token}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopiedToken(token);
      setTimeout(() => setCopiedToken(null), 2000);
    });
  };

  return (
    <>
      <article className="profile-card staff-management-card">
        <header>
          <div className="staff-header-row">
            <div>
              <h2>Team</h2>
              <p>Manage your restaurant staff and invite new members.</p>
            </div>
            <button
              type="button"
              className="staff-invite-btn"
              onClick={() => setShowInviteModal(true)}
            >
              <Icon name="person_add" />
              Invite
            </button>
          </div>
        </header>

        {error && (
          <div className="staff-error">
            <Icon name="error" />
            <span>{error}</span>
            <button type="button" onClick={() => setError(null)}>×</button>
          </div>
        )}

        {loading ? (
          <div className="staff-loading">
            <span>Loading team…</span>
          </div>
        ) : (
          <>
            <ul className="staff-member-list">
              {members.map((m) => (
                <li key={m.user_id} className="staff-member-row">
                  <div className="staff-member-avatar">
                    {(m.name || m.email || "?").charAt(0).toUpperCase()}
                  </div>
                  <div className="staff-member-info">
                    <strong>{m.name || m.email}</strong>
                    <span>{m.email}</span>
                  </div>
                  <div className="staff-member-actions">
                    {m.role === "owner" ? (
                      <span
                        className="staff-role-badge"
                        style={{ "--badge-color": ROLE_COLORS.owner }}
                        title="Restaurant owner cannot be changed"
                      >
                        {ROLE_LABELS.owner}
                      </span>
                    ) : isOwner ? (
                      <select
                        className="staff-role-select"
                        value={m.role}
                        onChange={(e) => handleRoleChange(m.user_id, e.target.value)}
                        disabled={actionLoading === m.user_id}
                      >
                        {ASSIGNABLE_ROLES.map((r) => (
                          <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                        ))}
                      </select>
                    ) : (
                      <span
                        className="staff-role-badge"
                        style={{ "--badge-color": ROLE_COLORS[m.role] || ROLE_COLORS.staff }}
                      >
                        {ROLE_LABELS[m.role] || m.role}
                      </span>
                    )}
                    {canRemoveMember(m) && (
                      <button
                        type="button"
                        className="staff-remove-btn"
                        onClick={() =>
                          setConfirmAction({
                            title: "Remove member?",
                            message: `${m.name || m.email} will lose access to this restaurant. You can invite them again later.`,
                            confirmLabel: "Remove member",
                            run: () => handleRemove(m.user_id)
                          })
                        }
                        title="Remove member"
                      >
                        <Icon name="person_remove" />
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>

            {pendingInvites.length > 0 && (
              <div className="staff-pending-section">
                <h3>Pending Invites</h3>
                <ul className="staff-invite-list">
                  {pendingInvites.map((inv) => (
                    <li key={inv.id} className="staff-invite-row">
                      <div className="staff-invite-info">
                        <Icon name="mail" />
                        <div>
                          <strong>{inv.email}</strong>
                          <span>
                            {ROLE_LABELS[inv.role] || inv.role} ·
                            expires {new Date(inv.expires_at).toLocaleDateString()}
                          </span>
                        </div>
                      </div>
                      <div className="staff-invite-actions">
                        <button
                          type="button"
                          className="staff-copy-btn"
                          onClick={() => handleCopyLink(inv.token)}
                          title="Copy invite link"
                        >
                          <Icon name={copiedToken === inv.token ? "check" : "content_copy"} />
                        </button>
                        <button
                          type="button"
                          className="staff-revoke-btn"
                          onClick={() =>
                            setConfirmAction({
                              title: "Revoke this invite?",
                              message: `The invite to ${inv.email} will be cancelled and its link will stop working immediately.`,
                              confirmLabel: "Revoke invite",
                              run: () => handleRevoke(inv.id)
                            })
                          }
                          title="Revoke invite"
                        >
                          <Icon name="close" />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </article>

      {showInviteModal && (
        <InviteModal
          isOwner={isOwner}
          onClose={() => setShowInviteModal(false)}
          onCreated={loadStaff}
          onInvited={() => {
            setShowInviteModal(false);
            loadStaff();
          }}
        />
      )}

      {confirmAction && (
        <ConfirmModal
          title={confirmAction.title}
          message={confirmAction.message}
          confirmLabel={confirmAction.confirmLabel}
          busy={confirmBusy}
          onConfirm={runConfirm}
          onCancel={() => setConfirmAction(null)}
        />
      )}
    </>
  );
}

// ─── Invite Modal ───────────────────────────────────────────────────────────

function InviteModal({ isOwner, onClose, onInvited, onCreated }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("server");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [copied, setCopied] = useState(false);
  const inviteRoles = isOwner ? ASSIGNABLE_ROLES : MANAGER_INVITABLE_ROLES;
  const canNativeShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const result = await inviteStaff({ email, role });
      const url = `${window.location.origin}/invite?token=${result.token}`;
      setSuccess(url);
      // Surface the new pending invite in the list underneath right away, so
      // it's there no matter how the modal is dismissed (Done, ✕, or overlay)
      // — no page refresh needed.
      onCreated?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopy = () => {
    if (!success) return;
    navigator.clipboard.writeText(success);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Tier-0 sharing: hand the invite link to the channels a restaurant actually
  // uses (WhatsApp / SMS / email) with zero backend — no transactional-email
  // service, no deliverability setup. The native share sheet is offered too
  // when the browser supports it (best on phones).
  const shareText = success
    ? `You've been invited to join our team on VoxTable as ${ROLE_LABELS[role] || role}. Tap to accept: ${success}`
    : "";
  const shareViaWhatsApp = () =>
    window.open(`https://wa.me/?text=${encodeURIComponent(shareText)}`, "_blank", "noopener,noreferrer");
  const shareViaEmail = () => {
    const subject = encodeURIComponent("Your VoxTable team invite");
    window.location.href = `mailto:${encodeURIComponent(email)}?subject=${subject}&body=${encodeURIComponent(shareText)}`;
  };
  const shareViaSms = () => {
    window.location.href = `sms:?&body=${encodeURIComponent(shareText)}`;
  };
  const shareNative = async () => {
    try {
      await navigator.share({ title: "VoxTable team invite", text: shareText, url: success });
    } catch {
      /* user dismissed the native share sheet */
    }
  };

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="invite-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div className="modal-card new-booking-modal">
        <header className="new-booking-head">
          <div>
            <h2 id="invite-modal-title" className="modal-title">Invite team member</h2>
            <p className="modal-description">
              Send an invite link to add a new member to your restaurant.
            </p>
          </div>
          <button
            type="button"
            className="new-booking-close"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close"
          >
            <Icon name="close" />
          </button>
        </header>

        {success ? (
          <div className="new-booking-form">
            <div className="staff-modal-success">
              <Icon name="check_circle" />
              <p>Invite created — share this link with {email}:</p>
              <div className="staff-invite-link-box">
                <code>{success}</code>
                <button type="button" onClick={handleCopy}>
                  <Icon name={copied ? "check" : "content_copy"} /> {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <div className="staff-share-row">
                {canNativeShare && (
                  <button type="button" className="staff-share-btn" onClick={shareNative}>
                    <Icon name="share" /> Share…
                  </button>
                )}
                <button type="button" className="staff-share-btn whatsapp" onClick={shareViaWhatsApp}>
                  <Icon name="chat" /> WhatsApp
                </button>
                <button type="button" className="staff-share-btn email" onClick={shareViaEmail}>
                  <Icon name="mail" /> Email
                </button>
                <button type="button" className="staff-share-btn sms" onClick={shareViaSms}>
                  <Icon name="sms" /> SMS
                </button>
              </div>
            </div>
            <div className="modal-actions">
              <button type="button" className="modal-button confirm" onClick={onInvited}>
                Done
              </button>
            </div>
          </div>
        ) : (
          <form className="new-booking-form" onSubmit={handleSubmit} autoComplete="off">
            {error ? (
              <div className="nb-error" role="alert">
                <Icon name="error_outline" />
                <div>
                  <p>{error}</p>
                </div>
              </div>
            ) : null}

            <label className="nb-field">
              <span>Email address</span>
              <input
                type="email"
                placeholder="team@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
                lang="en"
              />
            </label>

            <div className="nb-field">
              <span>Role</span>
              <div className="role-picker" role="radiogroup" aria-label="Role">
                {inviteRoles.map((r) => (
                  <button
                    type="button"
                    key={r}
                    role="radio"
                    aria-checked={role === r}
                    className={`role-option ${role === r ? "selected" : ""}`}
                    onClick={() => setRole(r)}
                  >
                    <span className="role-option-head">
                      <Icon name={ROLE_ICONS[r]} />
                      <strong>{ROLE_LABELS[r]}</strong>
                      {role === r && <Icon name="check_circle" className="role-option-check" />}
                    </span>
                    <span className="role-option-desc">{ROLE_DESCRIPTIONS[r]}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="modal-actions">
              <button
                type="button"
                className="modal-button ghost"
                onClick={onClose}
                disabled={submitting}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="modal-button confirm"
                disabled={submitting || !email}
              >
                {submitting ? (
                  <>
                    <span className="modal-spinner" aria-hidden="true" />
                    Sending…
                  </>
                ) : (
                  "Send invite"
                )}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

// ─── Confirm Modal ──────────────────────────────────────────────────────────
// Reuses the booking-modal shell so destructive staff actions get an on-brand,
// keyboard-/overlay-dismissable confirmation instead of the browser's native
// confirm() dialog. Generic on purpose — revoke an invite, remove a member, etc.

function ConfirmModal({ title, message, confirmLabel, busy, onConfirm, onCancel }) {
  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div className="modal-card new-booking-modal staff-confirm-modal">
        <header className="new-booking-head">
          <div>
            <h2 id="confirm-modal-title" className="modal-title">{title}</h2>
            <p className="modal-description">{message}</p>
          </div>
          <button
            type="button"
            className="new-booking-close"
            onClick={onCancel}
            disabled={busy}
            aria-label="Close"
          >
            <Icon name="close" />
          </button>
        </header>
        <div className="modal-actions">
          <button type="button" className="modal-button ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="modal-button danger" onClick={onConfirm} disabled={busy}>
            {busy ? (
              <>
                <span className="modal-spinner" aria-hidden="true" />
                Working…
              </>
            ) : (
              confirmLabel
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
