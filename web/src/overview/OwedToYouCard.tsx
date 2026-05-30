import { money } from '../format';
import { owedByFriend } from '../splitwise/owed';
import { useSplitwise } from '../splitwise/useSplitwise';

// Overview card: friends who currently owe the user money, from Hon's own
// tracked splits (owed − linked repayments). Hidden until Splitwise is
// connected; "all settled up" when nothing is owed. Splitwise's own settle-up
// flag is intentionally not consulted — only real linked repayments reduce this.
export function OwedToYouCard() {
  const sw = useSplitwise();
  if (!sw.connected) return null;

  const owing = owedByFriend(sw.links);

  return (
    <section className="card">
      <div className="card-head">
        <h3>Owed to you</h3>
        <span className="spacer" />
        <span className="meta">via Splitwise</span>
      </div>
      {owing.length > 0 ? (
        <div className="list">
          {owing.map((f) => (
            <div key={`${f.id}-${f.currency}`} className="row">
              <div className="name">{f.name}</div>
              <span className="amount pos">{money(f.owed, f.currency)}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty">You're all settled up on Splitwise.</div>
      )}
    </section>
  );
}
