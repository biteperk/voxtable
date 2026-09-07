import { Badge } from "../../../components/admin/Badge";
import { EmptyState } from "../../../components/admin/EmptyState";
import { SectionCard } from "../../../components/admin/SectionCard";

/**
 * Who can sign in for this venue. Read-only for now: there is no admin route
 * that grants membership, and Camilo's own venue is owned by a colleague's
 * address — worth seeing plainly rather than guessing at.
 */
export function TeamCard({ members }) {
  return (
    <SectionCard
      title="Team"
      icon="group"
      subtitle="Dashboard access is membership and nothing else — an allowlisted email with no row here still sees nothing."
    >
      {members?.length ? (
        <ul className="adm-audit-list">
          {members.map((m) => (
            <li key={m.userId ?? m.user_id ?? m.email}>
              <span className="adm-audit-what">{m.email ?? m.name ?? m.userId ?? m.user_id}</span>
              <Badge state={m.role === "owner" ? "ok" : "neutral"} icon={null}>
                {m.role}
              </Badge>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState icon="person_off" title="Nobody can sign in for this venue">
          There is no membership row, so no account can open this venue&apos;s dashboard. Members
          are added by invite from the venue itself.
        </EmptyState>
      )}
    </SectionCard>
  );
}
