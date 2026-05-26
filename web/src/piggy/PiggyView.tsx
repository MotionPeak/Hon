import { useCallback, useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { api } from '../api';
import { DelayedLoader } from '../ui/DelayedLoader';
import { money } from '../format';
import type { PiggyBankStatus, PiggyKind, PiggyReport } from './types';

// Mirrors PIGGY_EMOJI + PIGGY_PLANS in sidecar/public/app.html.
const PIGGY_EMOJI = ['🐷', '✈️', '🏖️', '🚗', '🏠', '💍', '🎓', '💻', '📷',
  '🎁', '🛋️', '🚲', '⛺️', '🎮', '🪙', '❤️'];
const PIGGY_PLANS = [3, 6, 12, 24];

const SYMBOL_ILS = '₪';

interface BudgetResponse {
  piggy: PiggyReport;
  currency?: string;
}

type DialogMode =
  | { kind: 'closed' }
  | { kind: 'new' }
  | { kind: 'edit'; bank: PiggyBankStatus }
  | { kind: 'delete'; bank: PiggyBankStatus };

export function PiggyView() {
  const [report, setReport] = useState<PiggyReport | null>(null);
  const [mode, setMode] = useState<DialogMode>({ kind: 'closed' });

  const reload = useCallback(async () => {
    try {
      const d = await api<BudgetResponse>('/budget');
      setReport(d.piggy);
    } catch {
      setReport({
        month: '', banks: [], fundedTotal: 0, headroom: 0, projected: false,
      });
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  if (report === null) return <DelayedLoader />;

  const cur = report.banks[0]?.currency ?? 'ILS';
  const skipped = report.banks.filter(
    (b) => !b.complete && b.thisMonth.status === 'skipped',
  ).length;
  const onHoldCount = report.banks.filter((b) => b.onHold && !b.complete).length;
  const incomeWord = report.projected ? 'your expected income' : 'income';

  const togglePause = async (bank: PiggyBankStatus): Promise<void> => {
    await api(`/piggy/${bank.id}`, 'PUT', { onHold: !bank.onHold });
    await reload();
  };

  const doDelete = async (bank: PiggyBankStatus): Promise<void> => {
    await api(`/piggy/${bank.id}`, 'DELETE');
    setMode({ kind: 'closed' });
    await reload();
  };

  return (
    <div className="piggy-view">
      <div className="piggy-head">
        <h1>Piggy banks</h1>
        <button
          type="button"
          className="btn-primary"
          onClick={() => setMode({ kind: 'new' })}
        >
          + New piggy bank
        </button>
      </div>
      <p className="set-intro">
        Money set aside each month for what you're saving up for. It counts as
        an expense — and pauses automatically on any month it doesn't fit
        your budget.
      </p>

      {report.banks.length === 0 ? (
        <p className="blank">
          🐷 No piggy banks yet. Create one for something you're saving toward —
          a trip, a new camera, a rainy-day fund — and Hon sets a little aside each
          month, counting it as an expense against your budget.
        </p>
      ) : (
        <>
          <div data-testid="piggy-headroom" className="piggy-headroom">
            <span className="emoji">🪙</span>
            <span>
              {report.headroom > 0
                ? <>Saving room this month — {incomeWord} less fixed bills and essentials: <b>{money(report.headroom, cur)}</b>.</>
                : <>There's no saving room this month — {incomeWord} is fully taken up by fixed bills and essentials.</>}
              {report.fundedTotal > 0 && <> <b>{money(report.fundedTotal, cur)}</b> set aside so far.</>}
              {skipped > 0 && <> {skipped} {skipped === 1 ? 'bank is' : 'banks are'} paused — they don't fit right now.</>}
              {onHoldCount > 0 && <> {onHoldCount} on hold.</>}
            </span>
          </div>
          <div className="piggy-grid">
            {report.banks.map((b) => (
              <PiggyCard
                key={b.id}
                bank={b}
                onEdit={() => setMode({ kind: 'edit', bank: b })}
                onTogglePause={() => togglePause(b)}
                onDelete={() => setMode({ kind: 'delete', bank: b })}
              />
            ))}
          </div>
        </>
      )}

      <PiggyFormDialog
        mode={mode}
        onClose={() => setMode({ kind: 'closed' })}
        onSaved={async () => { setMode({ kind: 'closed' }); await reload(); }}
      />
      <DeleteConfirmDialog
        mode={mode}
        onClose={() => setMode({ kind: 'closed' })}
        onConfirm={doDelete}
      />
    </div>
  );
}

function PiggyCard({
  bank, onEdit, onTogglePause, onDelete,
}: {
  bank: PiggyBankStatus;
  onEdit: () => void;
  onTogglePause: () => void;
  onDelete: () => void;
}) {
  const cur = bank.currency || 'ILS';
  const lump = bank.kind === 'lump';
  const reserved = lump && bank.thisMonth.status === 'reserved';
  const pct = Math.round(bank.progress * 100);
  const deg = Math.max(0, Math.min(360, bank.progress * 360));
  const ringColor = bank.complete ? 'var(--green)'
    : reserved ? 'var(--green)'
    : bank.onHold ? 'var(--hairline-2)'
    : bank.thisMonth.status === 'skipped' ? 'var(--amber)' : 'var(--accent)';
  const ringLabel = lump ? (reserved ? 'reserved' : 'set aside') : 'saved';

  let badge: React.ReactNode = null;
  if (bank.complete) {
    badge = (
      <div className="piggy-badge done">
        🎉 Goal reached — {money(bank.targetAmount, cur)} saved.
      </div>
    );
  } else if (bank.onHold) {
    badge = (
      <div className="piggy-badge onhold">
        ⏸ On hold — you've paused this piggy bank. Resume it any time to start saving again.
      </div>
    );
  } else if (lump && reserved) {
    badge = (
      <div className="piggy-badge done">
        🔒 {money(bank.targetAmount, cur)} set aside — held until you mark it used.
      </div>
    );
  } else if (lump) {
    badge = (
      <div className="piggy-badge funded">
        ✓ {money(bank.thisMonth.amount, cur)} reserved this month — counts as a fixed commitment in your budget.
      </div>
    );
  } else if (bank.thisMonth.status === 'funded') {
    badge = (
      <div className="piggy-badge funded">
        ✓ {money(bank.thisMonth.amount, cur)} set aside this month.
      </div>
    );
  } else {
    badge = (
      <div className="piggy-badge skipped">
        ⏸ Paused this month — the set-aside doesn't fit your budget right now.
      </div>
    );
  }

  return (
    <article className="piggy-card">
      <div className="piggy-card-top">
        <div className="piggy-emoji-lg">{bank.emoji}</div>
        <div className="piggy-name-wrap">
          <div className="piggy-name">{bank.name}</div>
          <div className="piggy-monthly">
            {money(bank.monthlyAmount, cur)}/mo
            {bank.monthsLeft != null && !bank.complete && (
              <> · {bank.monthsLeft} mo{bank.monthsLeft === 1 ? '' : 's'} to go</>
            )}
          </div>
        </div>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button type="button" className="kebab-btn" aria-label="Actions">⋮</button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="menu-content" sideOffset={4} align="end">
              <DropdownMenu.Item className="menu-item" onSelect={onEdit}>
                Edit
              </DropdownMenu.Item>
              <DropdownMenu.Item className="menu-item" onSelect={onTogglePause}>
                {bank.onHold ? 'Resume' : 'Pause'}
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="menu-sep" />
              <DropdownMenu.Item className="menu-item danger" onSelect={onDelete}>
                Delete
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
      <div
        className="piggy-ring"
        style={{ background: `conic-gradient(${ringColor} ${deg.toFixed(1)}deg, var(--card-hi) 0)` }}
      >
        <div className="piggy-hole">
          <div className="piggy-pct">{pct}%</div>
          <div className="piggy-pct-lbl">{ringLabel}</div>
        </div>
      </div>
      <div className="piggy-figs">
        <div className="piggy-saved">{money(bank.saved, cur)}</div>
        <div className="piggy-target">
          of {money(bank.targetAmount, cur)}
        </div>
      </div>
      {badge}
    </article>
  );
}

interface FormState {
  name: string;
  emoji: string;
  kind: PiggyKind;
  targetAmount: string;
  monthlyAmount: string;
}

function formFor(bank: PiggyBankStatus | null): FormState {
  if (!bank) return { name: '', emoji: '🐷', kind: 'monthly', targetAmount: '', monthlyAmount: '' };
  return {
    name: bank.name,
    emoji: bank.emoji,
    kind: bank.kind,
    targetAmount: String(bank.targetAmount),
    monthlyAmount: String(bank.monthlyAmount),
  };
}

function presetFor(target: number, months: number): number | null {
  if (!Number.isFinite(target) || target <= 0) return null;
  return Math.max(10, Math.ceil(target / months / 10) * 10);
}

function PiggyFormDialog({
  mode, onClose, onSaved,
}: {
  mode: DialogMode;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const open = mode.kind === 'new' || mode.kind === 'edit';
  const editing = mode.kind === 'edit';
  const bank = mode.kind === 'edit' ? mode.bank : null;
  const [form, setForm] = useState<FormState>(formFor(bank));
  const [planSel, setPlanSel] = useState<number | 'custom'>('custom');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setForm(formFor(bank));
      setPlanSel('custom');
      setError(null);
      setSaving(false);
    }
  }, [open, bank]);

  const target = Number(form.targetAmount);
  const monthly = Number(form.monthlyAmount);
  const targetValid = Number.isFinite(target) && target > 0;
  const monthlyValid = Number.isFinite(monthly) && monthly > 0;
  const lump = form.kind === 'lump';

  const eta = useMemo(() => {
    if (lump || !targetValid || !monthlyValid) return null;
    const months = Math.ceil(target / monthly);
    return `At ${money(monthly, 'ILS')} a month you'll reach ${money(target, 'ILS')} in about ${months} ${months === 1 ? 'month' : 'months'}.`;
  }, [lump, targetValid, monthlyValid, target, monthly]);

  const setKind = (kind: PiggyKind): void => {
    setForm((f) => ({ ...f, kind }));
  };
  const setEmoji = (emoji: string): void => {
    setForm((f) => ({ ...f, emoji }));
  };
  const onTargetChange = (v: string): void => {
    setForm((f) => {
      const next = { ...f, targetAmount: v };
      if (typeof planSel === 'number') {
        const pm = presetFor(Number(v), planSel);
        if (pm != null) next.monthlyAmount = String(pm);
      }
      return next;
    });
  };
  const onMonthlyChange = (v: string): void => {
    setPlanSel('custom');
    setForm((f) => ({ ...f, monthlyAmount: v }));
  };
  const onPlanClick = (months: number): void => {
    setPlanSel(months);
    const pm = presetFor(target, months);
    if (pm != null) setForm((f) => ({ ...f, monthlyAmount: String(pm) }));
  };

  const submit = async (): Promise<void> => {
    setError(null);
    if (!form.name.trim()) {
      setError('Give your piggy bank a name.'); return;
    }
    if (!targetValid) {
      setError(lump ? 'Enter the amount to set aside.' : 'Enter a goal amount.');
      return;
    }
    if (!lump && !monthlyValid) {
      setError('Choose a monthly set-aside.'); return;
    }
    setSaving(true);
    try {
      const body = {
        name: form.name.trim(),
        emoji: form.emoji || '🐷',
        kind: form.kind,
        targetAmount: target,
        monthlyAmount: lump ? 0 : monthly,
      };
      if (mode.kind === 'edit') {
        await api(`/piggy/${mode.bank.id}`, 'PUT', body);
      } else {
        await api('/piggy', 'POST', body);
      }
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="rx-overlay" />
        <Dialog.Content className="rx-dialog">
          <Dialog.Title>
            {editing ? 'Edit piggy bank' : 'New piggy bank'}
          </Dialog.Title>
          <Dialog.Description className="rx-dialog-desc">
            What are you saving up for? Either grow it a little each month,
            or reserve a lump sum now for an upcoming bill.
          </Dialog.Description>
          <form
            className="piggy-form"
            onSubmit={(e) => { e.preventDefault(); void submit(); }}
          >
            <label className="fld-lbl">Type</label>
            <div
              className="seg pgy-kind"
              role="group"
              aria-label="Type"
              data-kind={form.kind}
            >
              <button
                type="button"
                className={form.kind === 'monthly' ? 'on' : ''}
                onClick={() => setKind('monthly')}
              >
                <span className="pgy-kind-t">Monthly</span>
                <span className="pgy-kind-s">save each month</span>
              </button>
              <button
                type="button"
                className={form.kind === 'lump' ? 'on' : ''}
                onClick={() => setKind('lump')}
              >
                <span className="pgy-kind-t">Set aside once</span>
                <span className="pgy-kind-s">reserve a lump sum</span>
              </button>
            </div>

            <label className="fld-lbl">Icon</label>
            <div className="pgy-em-row">
              {PIGGY_EMOJI.map((e) => (
                <button
                  key={e}
                  type="button"
                  className={`pgy-em${e === form.emoji ? ' on' : ''}`}
                  aria-label={`Icon ${e}`}
                  aria-pressed={e === form.emoji}
                  onClick={() => setEmoji(e)}
                >{e}</button>
              ))}
            </div>

            <label htmlFor="pgy-name" className="fld-lbl">Name</label>
            <input
              id="pgy-name"
              type="text"
              maxLength={40}
              placeholder="New camera, summer trip…"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              autoFocus
            />

            <label htmlFor="pgy-target" className="fld-lbl" style={{ marginTop: 13 }}>
              {lump ? 'Amount to set aside' : 'Goal amount'}
            </label>
            <div className="pgy-amt">
              <span>{SYMBOL_ILS}</span>
              <input
                id="pgy-target"
                type="number"
                min={0}
                step={50}
                placeholder="0"
                value={form.targetAmount}
                onChange={(e) => onTargetChange(e.target.value)}
              />
            </div>

            {!lump && (
              <>
                <label htmlFor="pgy-monthly" className="fld-lbl">Monthly set-aside</label>
                <div id="pgy-plans">
                  {!targetValid ? (
                    <div className="pgy-plan-hint">
                      Enter a goal amount to see monthly options.
                    </div>
                  ) : (
                    PIGGY_PLANS.map((m) => {
                      const pm = presetFor(target, m) ?? 0;
                      return (
                        <button
                          key={m}
                          type="button"
                          className={`pgy-plan${planSel === m ? ' on' : ''}`}
                          onClick={() => onPlanClick(m)}
                        >
                          <span className="pgy-plan-amt">{money(pm, 'ILS')}</span>
                          <span className="pgy-plan-sub">
                            a month · ready in {m} months
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
                <div className="pgy-custom">
                  <span>{SYMBOL_ILS}</span>
                  <input
                    id="pgy-monthly"
                    type="number"
                    min={0}
                    step={10}
                    placeholder="Custom amount"
                    value={form.monthlyAmount}
                    onChange={(e) => onMonthlyChange(e.target.value)}
                  />
                </div>
                {eta && <div className="pgy-modal-eta">{eta}</div>}
              </>
            )}

            {lump && (
              <div className="pgy-modal-eta">
                The full amount is reserved the first month it fits your budget,
                then held until you mark it used.
              </div>
            )}

            {error && <p className="form-error">{error}</p>}
            <div className="form-actions">
              <Dialog.Close asChild>
                <button type="button" className="btn-ghost">Cancel</button>
              </Dialog.Close>
              <button type="submit" className="btn-primary" disabled={saving}>
                {saving ? 'Saving…' : editing ? 'Save changes' : 'Create piggy bank'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function DeleteConfirmDialog({
  mode, onClose, onConfirm,
}: {
  mode: DialogMode;
  onClose: () => void;
  onConfirm: (bank: PiggyBankStatus) => void | Promise<void>;
}) {
  const open = mode.kind === 'delete';
  const bank = mode.kind === 'delete' ? mode.bank : null;
  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="rx-overlay" />
        <Dialog.Content className="rx-dialog rx-dialog-sm">
          <Dialog.Title>Delete {bank?.name}</Dialog.Title>
          <Dialog.Description className="rx-dialog-desc">
            This removes the piggy bank and its month-by-month set-aside
            history. The transactions it was funded from stay put.
          </Dialog.Description>
          <div className="form-actions">
            <Dialog.Close asChild>
              <button type="button" className="btn-ghost">Cancel</button>
            </Dialog.Close>
            <button
              type="button"
              className="btn-danger"
              onClick={() => bank && void onConfirm(bank)}
            >
              Delete
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
