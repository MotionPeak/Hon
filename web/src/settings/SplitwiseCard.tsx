// Stub: Splitwise connect / disconnect / refresh against /splitwise/* —
// deferred. The full flow needs OAuth state, group selection, and refund
// linking; landing the placeholder now so the SettingsView layout matches.
export function SplitwiseCard() {
  return (
    <section className="set-card set-card--wide">
      <div className="set-card-head">
        <span className="set-ico">🤝</span>
        <h3>Splitwise</h3>
      </div>
      <p className="set-hint">Coming soon. Connect Splitwise from the legacy app for now.</p>
    </section>
  );
}
