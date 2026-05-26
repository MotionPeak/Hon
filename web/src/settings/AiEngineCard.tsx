// Stub: the AI engine panel (local llama / Ollama / Apple Intelligence
// selector) is wired against /llm/* in the old app. Porting it requires
// modelling the LLM provider state machine and a multi-step download UI;
// deferred to a follow-up so the rest of Settings can ship first.
export function AiEngineCard() {
  return (
    <section className="set-card">
      <div className="set-card-head">
        <span className="set-ico">🧠</span>
        <h3>AI engine</h3>
      </div>
      <p className="set-hint">Coming soon. Configure the AI engine from the legacy app for now.</p>
    </section>
  );
}
