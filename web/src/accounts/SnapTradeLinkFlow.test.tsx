import { useState } from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { installFetchMock, jsonResponse } from '../test/mockFetch';
import { SnapTradeLinkFlow } from './SnapTradeLinkFlow';

/** Parent-owned wrapper — closes the modal on cancel like AccountsView does. */
function Harness(props: Parameters<typeof SnapTradeLinkFlow>[0]) {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return (
    <SnapTradeLinkFlow
      {...props}
      onCancel={() => { props.onCancel(); setOpen(false); }}
    />
  );
}

const BROKERS = [
  { slug: 'INTERACTIVE_BROKERS', name: 'Interactive Brokers' },
  { slug: 'SCHWAB', name: 'Charles Schwab' },
];

function defaultRoutes(overrides: Record<string, (body?: unknown) => unknown> = {}): Record<string, (body?: unknown) => unknown> {
  return {
    'POST /api/snaptrade/brokerages': () => ({ brokerages: BROKERS }),
    'POST /api/snaptrade/portal': () => ({
      portal: {
        userId: 'u1', userSecret: 's1',
        redirectURI: 'https://snaptrade.com/portal/abc',
        connectionCount: 0, atLimit: false,
      },
    }),
    'GET /api/snaptrade/connections/conn-1/count': () => ({ count: 0 }),
    ...overrides,
  };
}

describe('SnapTradeLinkFlow', () => {
  let openSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    // shouldAdvanceTime keeps waitFor from deadlocking when we're also
    // using fake timers to advance the poll interval manually.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('loads brokerages on mount and shows the picker', async () => {
    installFetchMock(defaultRoutes());
    render(<SnapTradeLinkFlow connectionId="conn-1" onLinked={async () => ({ accountsAdded: 0 })} onCancel={() => {}} />);
    await vi.advanceTimersByTimeAsync(0);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Interactive Brokers/i })).toBeInTheDocument();
    });
  });

  it('picking a broker opens the portal in a new tab and starts polling', async () => {
    installFetchMock(defaultRoutes());
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<SnapTradeLinkFlow connectionId="conn-1" onLinked={async () => ({ accountsAdded: 0 })} onCancel={() => {}} />);
    await vi.advanceTimersByTimeAsync(0);
    await screen.findByRole('button', { name: /Interactive Brokers/i });
    await user.click(screen.getByRole('button', { name: /Interactive Brokers/i }));

    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith(
        'https://snaptrade.com/portal/abc', 'snaptrade-portal', 'noopener,noreferrer',
      );
    });
    expect(screen.getByText(/finish linking in the SnapTrade tab/i)).toBeInTheDocument();
  });

  it('embeds honConn in customRedirect so /done can record completion', async () => {
    let portalBody: { customRedirect?: string } | undefined;
    installFetchMock(defaultRoutes({
      'POST /api/snaptrade/portal': (body) => {
        portalBody = body as { customRedirect?: string };
        return {
          portal: {
            userId: 'u1', userSecret: 's1',
            redirectURI: 'https://snaptrade.com/portal/abc',
            connectionCount: 0, atLimit: false,
          },
        };
      },
    }));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<SnapTradeLinkFlow connectionId="conn-1" onLinked={async () => ({ accountsAdded: 0 })} onCancel={() => {}} />);
    await vi.advanceTimersByTimeAsync(0);
    await screen.findByRole('button', { name: /Interactive Brokers/i });
    await user.click(screen.getByRole('button', { name: /Interactive Brokers/i }));

    await waitFor(() => {
      expect(portalBody?.customRedirect).toBeDefined();
    });
    expect(portalBody!.customRedirect).toMatch(
      /\/api\/snaptrade\/done\?honConn=conn-1$/,
    );
  });

  it('when the poll detects a new connection, calls onLinked and shows done', async () => {
    let count = 0;
    installFetchMock(defaultRoutes({
      'GET /api/snaptrade/connections/conn-1/count': () => ({ count }),
    }));
    const onLinked = vi.fn().mockResolvedValue({ accountsAdded: 3 });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<SnapTradeLinkFlow connectionId="conn-1" onLinked={onLinked} onCancel={() => {}} />);

    await vi.advanceTimersByTimeAsync(0);
    await screen.findByRole('button', { name: /Interactive Brokers/i });
    await user.click(screen.getByRole('button', { name: /Interactive Brokers/i }));

    // After portal opens, baseline is 0. Bump count to 1, advance one tick.
    await waitFor(() => expect(openSpy).toHaveBeenCalled());
    count = 1;
    await vi.advanceTimersByTimeAsync(3_000);

    await waitFor(() => expect(onLinked).toHaveBeenCalled());
    await waitFor(() => {
      expect(screen.getByText(/Interactive Brokers/i)).toBeInTheDocument();
      expect(screen.getByText(/3 accounts/i)).toBeInTheDocument();
    });
  });

  it('shows "connection refreshed" copy when accountsAdded is 0 (re-link of same broker)', async () => {
    installFetchMock(defaultRoutes({
      // count stays at baseline 0, but server reports done:true after portal callback
      'GET /api/snaptrade/connections/conn-1/count': () => ({ count: 0, done: true }),
    }));
    const onLinked = vi.fn().mockResolvedValue({ accountsAdded: 0 });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<SnapTradeLinkFlow connectionId="conn-1" onLinked={onLinked} onCancel={() => {}} />);

    await vi.advanceTimersByTimeAsync(0);
    await screen.findByRole('button', { name: /Interactive Brokers/i });
    await user.click(screen.getByRole('button', { name: /Interactive Brokers/i }));

    await waitFor(() => expect(openSpy).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(0);

    await waitFor(() => expect(onLinked).toHaveBeenCalled());
    await waitFor(() => {
      expect(screen.getByText(/connection refreshed/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/0 accounts? added/i)).toBeNull();
  });

  it('shows the atLimit error when /portal reports atLimit', async () => {
    installFetchMock(defaultRoutes({
      'POST /api/snaptrade/portal': () => ({
        portal: {
          userId: 'u1', userSecret: 's1', redirectURI: '',
          connectionCount: 5, atLimit: true,
        },
      }),
    }));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<SnapTradeLinkFlow connectionId="conn-1" onLinked={async () => ({ accountsAdded: 0 })} onCancel={() => {}} />);
    await vi.advanceTimersByTimeAsync(0);
    await screen.findByRole('button', { name: /Interactive Brokers/i });
    await user.click(screen.getByRole('button', { name: /Interactive Brokers/i }));

    await waitFor(() => {
      expect(screen.getByText(/5-brokerage SnapTrade free tier limit/i)).toBeInTheDocument();
    });
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('shows "vault is locked" when /brokerages returns 409', async () => {
    installFetchMock(defaultRoutes({
      'POST /api/snaptrade/brokerages': () => jsonResponse(409, { error: 'the credential vault is locked' }),
    }));
    render(<SnapTradeLinkFlow connectionId="conn-1" onLinked={async () => ({ accountsAdded: 0 })} onCancel={() => {}} />);
    await vi.advanceTimersByTimeAsync(0);
    await waitFor(() => {
      expect(screen.getByText(/unlock your vault/i)).toBeInTheDocument();
    });
  });

  it('cancel during polling fires onCancel and stops polling (parent unmounts)', async () => {
    const fetchSpy = installFetchMock(defaultRoutes());
    const onCancel = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<Harness connectionId="conn-1" onLinked={async () => ({ accountsAdded: 0 })} onCancel={onCancel} />);

    await vi.advanceTimersByTimeAsync(0);
    await screen.findByRole('button', { name: /Interactive Brokers/i });
    await user.click(screen.getByRole('button', { name: /Interactive Brokers/i }));
    await waitFor(() => expect(openSpy).toHaveBeenCalled());

    const callsAtCancel = fetchSpy.mock.calls.length;
    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
    // Parent (Harness) unmounted SnapTradeLinkFlow on cancel — polling must stop.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchSpy.mock.calls.length).toBe(callsAtCancel);
  });
});
