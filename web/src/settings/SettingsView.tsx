import { AiEngineCard } from './AiEngineCard';
import { BillingCycleCard } from './BillingCycleCard';
import { CategoriesPanel } from './CategoriesPanel';
import { CategoryAveragesCard } from './CategoryAveragesCard';
import { CreditCardBillsCard } from './CreditCardBillsCard';
import { SpendingProjectionCard } from './SpendingProjectionCard';
import { SplitwiseCard } from './SplitwiseCard';
import { VaultCard } from './VaultCard';

// No own SettingsProvider — Hon mounts a single app-level provider (App.tsx),
// so settings changes made here propagate live to every other tab. A nested
// provider here would shadow it and leave other tabs stale until reload.
export function SettingsView() {
  return (
    <div className="settings-view">
      <h1>Settings</h1>
      <p className="set-intro">
        Pick your AI engine and tune how Hon reads your money. Changes save as you make them.
      </p>
      <div className="set-grid">
        <VaultCard />
        <AiEngineCard />
        <BillingCycleCard />
        <SpendingProjectionCard />
        <CategoryAveragesCard />
        <CreditCardBillsCard />
        <SplitwiseCard />
        <section className="set-card">
          <div className="set-card-head">
            <span className="set-ico">🏷️</span>
            <h3>Categories</h3>
          </div>
          <p className="set-hint">
            Tap any category to change its icon, colour, or whether it counts as an
            essential, fixed bill, or variable expense. Add your own — they apply
            everywhere, including the auto-categorizer.
          </p>
          <CategoriesPanel />
        </section>
      </div>
    </div>
  );
}
