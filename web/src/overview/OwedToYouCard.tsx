import { money } from '../format';
import { useSplitwise } from '../splitwise/useSplitwise';

// Overview card: Splitwise friends who currently owe the user money. Hidden
// until Splitwise is connected; "all settled up" when no one owes anything.
export function OwedToYouCard() {
  const sw = useSplitwise();
  if (!sw.connected) return null;

  const owing = sw.friends
    .map((f) => ({ name: f.name, owed: f.balances.filter((b) => b.amount > 0) }))
    .filter((f) => f.owed.length > 0);

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
            <div key={f.name} className="row">
              <div className="name">{f.name}</div>
              <span className="amount pos">
                {f.owed.map((b) => money(b.amount, b.currency)).join(' · ')}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty">You're all settled up on Splitwise.</div>
      )}
    </section>
  );
}
