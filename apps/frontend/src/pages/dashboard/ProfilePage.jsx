import { useEffect, useState } from "react";
import { useAuth } from "../../auth";
import { signOutUser } from "../../firebase";
import {
  getStaffList,
  inviteStaff,
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
  owner: "var(--primary, #6ee7b7)",
  manager: "var(--accent, #818cf8)",
  server: "var(--info, #38bdf8)",
  kitchen: "var(--warning, #fbbf24)",
  staff: "var(--on-surface-variant, #94a3b8)"
};

const ASSIGNABLE_ROLES = ["manager", "server", "kitchen"];
const MANAGER_INVITABLE_ROLES = ["server", "kitchen"];

export function ProfilePage({ navigate }) {
  const { user, hasMinRole } = useAuth();
  const isManager = hasMinRole("manager");
  const isOwner = hasMinRole("owner");

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
          <p>Manage your account and how you sign in to VocoTable.</p>
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

        <article className="profile-card">
          <header>
            <h2>Sign-in methods</h2>
            <p>Choose how you want to access VocoTable. You can connect multiple providers.</p>
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
    </DashboardShell>
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

  const handleRemove = async (userId, name) => {
    if (!confirm(`Remove ${name || "this member"} from the restaurant?`)) return;
    setActionLoading(userId);
    try {
      await removeStaffMember(userId);
      await loadStaff();
    } catch (e) {
      setError(e.message);
    } finally {
      setActionLoading(null);
    }
  };

  const handleRevoke = async (inviteId) => {
    setActionLoading(inviteId);
    try {
      await revokeStaffInvite(inviteId);
      await loadStaff();
    } catch (e) {
      setError(e.message);
    } finally {
      setActionLoading(null);
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
                        onClick={() => handleRemove(m.user_id, m.name || m.email)}
                        disabled={actionLoading === m.user_id}
                        title="Remove member"
                      >
                        <Icon name="close" />
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
                          onClick={() => handleRevoke(inv.id)}
                          disabled={actionLoading === inv.id}
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
          onInvited={() => {
            setShowInviteModal(false);
            loadStaff();
          }}
        />
      )}
    </>
  );
}

// ─── Invite Modal ───────────────────────────────────────────────────────────

function InviteModal({ isOwner, onClose, onInvited }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("server");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const inviteRoles = isOwner ? ASSIGNABLE_ROLES : MANAGER_INVITABLE_ROLES;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const result = await inviteStaff({ email, role });
      const url = `${window.location.origin}/invite?token=${result.token}`;
      setSuccess(url);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopy = () => {
    if (success) {
      navigator.clipboard.writeText(success);
    }
  };

  return (
    <div className="staff-modal-backdrop" onClick={onClose}>
      <div className="staff-modal" onClick={(e) => e.stopPropagation()}>
        <div className="staff-modal-header">
          <h3>Invite Team Member</h3>
          <button type="button" className="staff-modal-close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>

        {success ? (
          <div className="staff-modal-success">
            <Icon name="check_circle" />
            <p>Invite sent! Share this link with your team member:</p>
            <div className="staff-invite-link-box">
              <code>{success}</code>
              <button type="button" onClick={handleCopy}>
                <Icon name="content_copy" /> Copy
              </button>
            </div>
            <div className="staff-modal-actions">
              <button type="button" onClick={onInvited}>Done</button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <div className="staff-modal-field">
              <label htmlFor="invite-email">Email address</label>
              <input
                id="invite-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="team@example.com"
                required
                autoFocus
              />
            </div>
            <div className="staff-modal-field">
              <label htmlFor="invite-role">Role</label>
              <select
                id="invite-role"
                value={role}
                onChange={(e) => setRole(e.target.value)}
              >
                {inviteRoles.map((r) => (
                  <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                ))}
              </select>
              <span className="staff-role-hint">
                {isOwner && role === "manager" && "Full access: menu, analytics, billing, staff management"}
                {role === "server" && "Front-of-house: live feed, bookings, tables"}
                {role === "kitchen" && "Kitchen only: order queue and status updates"}
              </span>
            </div>
            {error && (
              <div className="staff-modal-error">
                <Icon name="error" /> {error}
              </div>
            )}
            <div className="staff-modal-actions">
              <button type="button" className="ghost" onClick={onClose}>Cancel</button>
              <button type="submit" disabled={submitting || !email}>
                {submitting ? "Sending…" : "Send Invite"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

