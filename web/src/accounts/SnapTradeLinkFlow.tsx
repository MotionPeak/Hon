import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { SnapTradeBrokeragePicker } from './SnapTradeBrokeragePicker';
import { Countdown } from './Countdown';
import { useSnapTradeConnectionPoll } from './useSnapTradeConnectionPoll';
import type { BrokerageOption } from './types';

interface PortalResult {
  userId: string;
  userSecret: string;
  redirectURI: string;
  connectionCount: number;
  atLimit: boolean;
  error?: string;
}

interface Props {
  connectionId: string;
  /** When set, the modal skips the broker picker and goes straight to
   *  opening the portal for this broker. Used by AddConnectionPicker's
   *  inline brokerage list, which has already picked the broker. */
  initialBrokerSlug?: string;
  initialBrokerName?: string;
  /** Parent's existing scrape path. Resolves with the account count added. */
  onLinked: () => Promise<{ accountsAdded: number }>;
  onCancel: () => void;
}

const PORTAL_TTL_MS = 5 * 60 * 1000;

type State =
  | { kind: 'loading' }
  | { kind: 'picking'; brokerages: BrokerageOption[] }
  | { kind: 'opening'; brokerSlug: string; brokerName: string }
  | { kind: 'waiting'; brokerName: string; baseline: number; deadlineMs: number }
  | { kind: 'syncing'; brokerName: string }
  | { kind: 'done'; brokerName: string; accountsAdded: number }
  | { kind: 'error'; message: string; canRetry: boolean };

export function SnapTradeLinkFlow(
  { connectionId, initialBrokerSlug, initialBrokerName, onLinked, onCancel }: Props,
) {
  // If a broker is pre-selected by the parent (the Add-asset modal's
  // inline brokerage list), skip 'loading' + 'picking' and go straight
  // to 'opening' the portal for that broker.
  const [state, setState] = useState<State>(() =>
    initialBrokerSlug
      ? { kind: 'opening', brokerSlug: initialBrokerSlug, brokerName: initialBrokerName ?? initialBrokerSlug }
      : { kind: 'loading' },
  );

  // Load brokerages on mount — only when no broker was pre-selected.
  useEffect(() => {
    if (initialBrokerSlug) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api<{ brokerages: BrokerageOption[] }>(
          '/snaptrade/brokerages', 'POST', { connectionId },
        );
        if (cancelled) return;
        setState({ kind: 'picking', brokerages: res.brokerages });
      } catch (err) {
        if (cancelled) return;
        const status = err instanceof ApiError ? err.status : 0;
        if (status === 409) {
          setState({ kind: 'error', message: 'Unlock your vault to connect a brokerage.', canRetry: false });
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          setState({ kind: 'error', message: msg, canRetry: true });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [connectionId, initialBrokerSlug]);

  // Open portal when a broker is picked.
  useEffect(() => {
    if (state.kind !== 'opening') return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api<{ portal: PortalResult }>('/snaptrade/portal', 'POST', {
          connectionId,
          broker: state.brokerSlug,
          customRedirect: `${window.location.origin}/api/snaptrade/done?honConn=${encodeURIComponent(connectionId)}`,
        });
        if (cancelled) return;
        const p = res.portal;
        if (p.atLimit) {
          setState({
            kind: 'error',
            message: "You're at the 5-brokerage SnapTrade free tier limit. Unlink a brokerage first.",
            canRetry: false,
          });
          return;
        }
        if (p.error) {
          setState({ kind: 'error', message: p.error, canRetry: true });
          return;
        }
        if (!p.redirectURI) {
          setState({ kind: 'error', message: "SnapTrade didn't return a portal URL — try again.", canRetry: true });
          return;
        }
        window.open(p.redirectURI, 'snaptrade-portal', 'noopener,noreferrer');
        setState({
          kind: 'waiting',
          brokerName: state.brokerName,
          baseline: p.connectionCount,
          deadlineMs: Date.now() + PORTAL_TTL_MS,
        });
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setState({ kind: 'error', message: msg, canRetry: true });
      }
    })();
    return () => { cancelled = true; };
  }, [state, connectionId]);

  // Polling — runs only in the `waiting` state.
  useSnapTradeConnectionPoll({
    connectionId,
    baseline: state.kind === 'waiting' ? state.baseline : 0,
    enabled: state.kind === 'waiting',
    onIncrease: async () => {
      if (state.kind !== 'waiting') return;
      const brokerName = state.brokerName;
      setState({ kind: 'syncing', brokerName });
      try {
        const result = await onLinked();
        setState({ kind: 'done', brokerName, accountsAdded: result.accountsAdded });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setState({ kind: 'error', message: `Linked the brokerage, but the first sync failed: ${msg}`, canRetry: false });
      }
    },
    onTimeout: () => {
      setState({ kind: 'error', message: 'The SnapTrade portal expired (5 min).', canRetry: true });
    },
    onError: (msg) => {
      setState({ kind: 'error', message: `Lost connection to the engine: ${msg}`, canRetry: true });
    },
  });

  if (state.kind === 'loading') return <LoadingPanel />;
  if (state.kind === 'picking') {
    return (
      <PickingPanel
        brokerages={state.brokerages}
        onPick={(slug, name) => {
          setState({ kind: 'opening', brokerSlug: slug, brokerName: name });
        }}
        onCancel={onCancel}
      />
    );
  }
  if (state.kind === 'opening') return <OpeningPanel />;
  if (state.kind === 'waiting') {
    return <WaitingPanel brokerName={state.brokerName} deadlineMs={state.deadlineMs} onCancel={onCancel} />;
  }
  if (state.kind === 'syncing') return <SyncingPanel brokerName={state.brokerName} />;
  if (state.kind === 'done') {
    return <DonePanel brokerName={state.brokerName} accountsAdded={state.accountsAdded} onDone={onCancel} />;
  }
  return <ErrorPanel message={state.message} canRetry={state.canRetry} onRetry={() => setState({ kind: 'loading' })} onCancel={onCancel} />;
}

// ---- Sub-panels (declared at module level — rerender-no-inline-components) ----

function LoadingPanel() {
  return <p className="snaptrade-flow-loading">Loading brokerages…</p>;
}

function PickingPanel(
  { brokerages, onPick, onCancel }:
    { brokerages: BrokerageOption[]; onPick: (slug: string, name: string) => void; onCancel: () => void },
) {
  return (
    <div className="snaptrade-flow">
      <h2>Link a brokerage</h2>
      <p>Pick the brokerage you want to connect. You'll finish signing in on SnapTrade's secure page.</p>
      <SnapTradeBrokeragePicker brokerages={brokerages} onPick={onPick} />
      <div className="modal-actions"><button type="button" onClick={onCancel}>Cancel</button></div>
    </div>
  );
}

function OpeningPanel() {
  return <p className="snaptrade-flow-loading">Opening the SnapTrade portal…</p>;
}

function WaitingPanel(
  { brokerName, deadlineMs, onCancel }:
    { brokerName: string; deadlineMs: number; onCancel: () => void },
) {
  return (
    <div className="snaptrade-flow">
      <h2>Finish linking in the SnapTrade tab</h2>
      <p>
        We've opened SnapTrade's secure portal for <strong>{brokerName}</strong>. Complete the sign-in
        there — we'll pull your accounts the moment it finishes.
      </p>
      <p className="snaptrade-flow-meta">Portal expires in <Countdown deadlineMs={deadlineMs} />.</p>
      <div className="modal-actions"><button type="button" onClick={onCancel}>Cancel</button></div>
    </div>
  );
}

function SyncingPanel({ brokerName }: { brokerName: string }) {
  return <p className="snaptrade-flow-loading">Pulling your {brokerName} accounts…</p>;
}

function DonePanel(
  { brokerName, accountsAdded, onDone }:
    { brokerName: string; accountsAdded: number; onDone: () => void },
) {
  return (
    <div className="snaptrade-flow">
      <h2>Connected {brokerName}</h2>
      <p>
        {accountsAdded === 0
          ? `${brokerName} connection refreshed.`
          : `${accountsAdded} account${accountsAdded === 1 ? '' : 's'} added.`}
      </p>
      <div className="modal-actions"><button type="button" onClick={onDone}>Done</button></div>
    </div>
  );
}

function ErrorPanel(
  { message, canRetry, onRetry, onCancel }:
    { message: string; canRetry: boolean; onRetry: () => void; onCancel: () => void },
) {
  return (
    <div className="snaptrade-flow">
      <h2>Something went wrong</h2>
      <p className="snaptrade-flow-error">{message}</p>
      <div className="modal-actions">
        {canRetry && <button type="button" onClick={onRetry}>Try again</button>}
        <button type="button" onClick={onCancel}>Close</button>
      </div>
    </div>
  );
}
