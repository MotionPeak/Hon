import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { money } from '../format';
import type { Transaction } from '../activity/types';
import type { SplitwisePickList, SplitwiseShare } from './types';
import { displayName } from '../activity/displayName';

interface Props {
  open: boolean;
  transaction: Transaction;
  loadPickList: () => Promise<SplitwisePickList>;
  onCreate: (groupId: number | null, shares: SplitwiseShare[]) => Promise<void>;
  onClose: () => void;
}

type Picked =
  | { kind: 'friend'; id: number; name: string }
  | { kind: 'group'; id: number; name: string; members: { id: number; name: string }[] };

export function SplitwiseSheet({ open, transaction, loadPickList, onCreate, onClose }: Props) {
  const cost = Math.abs(transaction.amount);
  const [data, setData] = useState<SplitwisePickList | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [pick, setPick] = useState<Picked | null>(null);

  useEffect(() => {
    if (!open) return;
    setData(null); setLoadErr(null); setPick(null);
    let live = true;
    loadPickList()
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) setLoadErr(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [open, loadPickList]);

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="rx-overlay" />
        <Dialog.Content className="rx-dialog rx-dialog-sm" aria-label="Split on Splitwise">
          <Dialog.Title>
            {pick ? `Split with ${pick.name}` : 'Split on Splitwise'}
          </Dialog.Title>
          <Dialog.Description className="rx-dialog-desc">
            {displayName(transaction)} · {money(cost, transaction.currency)}
          </Dialog.Description>

          {loadErr && <p className="set-error" role="alert">{loadErr}</p>}
          {!loadErr && !data && <p className="rx-dialog-desc">Loading your friends and groups…</p>}

          {data && !pick && (
            <PickStep
              data={data}
              onPickFriend={(f) => setPick({ kind: 'friend', id: f.id, name: f.name })}
              onPickGroup={(g) =>
                setPick({ kind: 'group', id: g.id, name: g.name, members: g.members })}
            />
          )}

          {data && pick?.kind === 'friend' && (
            <FriendStep
              cost={cost} currency={transaction.currency} name={pick.name}
              onBack={() => setPick(null)}
              onCreate={(owed) => onCreate(null, [{ userId: pick.id, name: pick.name, owed }])}
            />
          )}

          {data && pick?.kind === 'group' && (
            <GroupStep
              cost={cost} currency={transaction.currency} meId={data.me?.id ?? null}
              group={pick}
              onBack={() => setPick(null)}
              onCreate={(shares) => onCreate(pick.id, shares)}
            />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PickStep({ data, onPickFriend, onPickGroup }: {
  data: SplitwisePickList;
  onPickFriend: (f: { id: number; name: string }) => void;
  onPickGroup: (g: { id: number; name: string; members: { id: number; name: string }[] }) => void;
}) {
  if (data.friends.length === 0 && data.groups.length === 0) {
    return (
      <p className="set-error">
        No Splitwise friends or groups — add some in the Splitwise app first.
      </p>
    );
  }
  return (
    <>
      {data.friends.length > 0 && <div className="label sb-label">Friends</div>}
      {data.friends.map((f) => (
        <button key={f.id} type="button" className="loan-pick-row" onClick={() => onPickFriend(f)}>
          <span className="loan-pick-name">🧑 {f.name}</span>
        </button>
      ))}
      {data.groups.length > 0 && <div className="label sb-label">Groups</div>}
      {data.groups.map((g) => (
        <button key={g.id} type="button" className="loan-pick-row" onClick={() => onPickGroup(g)}>
          <span className="loan-pick-name">👥 {g.name}</span>
        </button>
      ))}
    </>
  );
}

function FriendStep({ cost, currency, name, onBack, onCreate }: {
  cost: number; currency: string; name: string;
  onBack: () => void; onCreate: (owed: number) => Promise<void>;
}) {
  const [owed, setOwed] = useState((cost / 2).toFixed(2));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const v = Number(owed);

  const submit = async (): Promise<void> => {
    if (!Number.isFinite(v) || v <= 0) { setErr(`Enter how much ${name} owes you.`); return; }
    if (v > cost + 0.001) { setErr('That is more than the expense.'); return; }
    setBusy(true); setErr(null);
    try { await onCreate(v); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <>
      <div className="field">
        <label htmlFor="sw-owed">How much does {name} owe you?</label>
        <input
          id="sw-owed" type="number" min="0" step="0.01" value={owed}
          onChange={(e) => setOwed(e.target.value)}
        />
      </div>
      <p className="sub-hint">
        You keep {money(Math.max(0, cost - (Number.isFinite(v) ? v : 0)), currency)}; {name} owes
        you {money(Number.isFinite(v) ? Math.min(cost, Math.max(0, v)) : 0, currency)}.
      </p>
      {err && <p className="set-error" role="alert">{err}</p>}
      <div className="form-actions">
        <button type="button" className="btn-ghost" onClick={onBack}>‹ Back</button>
        <button type="button" className="btn-primary" disabled={busy} onClick={() => void submit()}>
          Add to Splitwise
        </button>
      </div>
    </>
  );
}

function GroupStep({ cost, currency, meId, group, onBack, onCreate }: {
  cost: number; currency: string; meId: number | null;
  group: { members: { id: number; name: string }[] };
  onBack: () => void; onCreate: (shares: SplitwiseShare[]) => Promise<void>;
}) {
  const others = group.members.filter((m) => m.id !== meId);
  const [ticked, setTicked] = useState<Set<number>>(() => new Set(others.map((m) => m.id)));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (others.length === 0) {
    return <p className="set-error">That group has no one else in it to split with.</p>;
  }
  const n = ticked.size + 1; // +1 for you
  const share = cost / n;

  const toggle = (id: number): void => setTicked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const submit = async (): Promise<void> => {
    if (ticked.size === 0) { setErr('Tick at least one person.'); return; }
    setBusy(true); setErr(null);
    const shares: SplitwiseShare[] = others
      .filter((m) => ticked.has(m.id))
      .map((m) => ({ userId: m.id, name: m.name, owed: cost / (ticked.size + 1) }));
    try { await onCreate(shares); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <>
      <div className="sw-members">
        {others.map((m) => (
          <label key={m.id} className="sw-member">
            <input type="checkbox" checked={ticked.has(m.id)} onChange={() => toggle(m.id)} />
            <span>{m.name}</span>
          </label>
        ))}
      </div>
      <p className="sub-hint">
        Each of {n} pays {money(share, currency)}; you're owed {money(cost - share, currency)}.
      </p>
      {err && <p className="set-error" role="alert">{err}</p>}
      <div className="form-actions">
        <button type="button" className="btn-ghost" onClick={onBack}>‹ Back</button>
        <button type="button" className="btn-primary" disabled={busy} onClick={() => void submit()}>
          Add to Splitwise
        </button>
      </div>
    </>
  );
}
