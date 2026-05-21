// One-off cleanup: frees a SnapTrade personal key's single user slot.
// Run from the sidecar dir:
//
//   SNAPTRADE_CLIENT_ID=... SNAPTRADE_CONSUMER_KEY=... \
//     node scripts/snaptrade-delete-user.mjs [userId]
//
// With a userId, deletes that user. With no userId, deletes EVERY registered
// user (clears all orphans). Credentials are read from the environment so the
// secret is never hard-coded. Deletion is irreversible.
import { Snaptrade } from 'snaptrade-typescript-sdk';

const clientId = process.env.SNAPTRADE_CLIENT_ID?.trim();
const consumerKey = process.env.SNAPTRADE_CONSUMER_KEY?.trim();
const onlyUserId = process.argv[2]?.trim();

if (!clientId || !consumerKey) {
  console.error(
    'Usage: SNAPTRADE_CLIENT_ID=... SNAPTRADE_CONSUMER_KEY=... ' +
      'node scripts/snaptrade-delete-user.mjs [userId]',
  );
  process.exit(1);
}

const snaptrade = new Snaptrade({ clientId, consumerKey });

try {
  const before = await snaptrade.authentication.listSnapTradeUsers();
  const users = Array.isArray(before.data) ? before.data : [];
  console.log('Users before:', users);

  const targets = onlyUserId ? [onlyUserId] : users;
  for (const userId of targets) {
    const res = await snaptrade.authentication.deleteSnapTradeUser({ userId });
    console.log(`Delete accepted for ${userId}:`, res.data);
  }

  const after = await snaptrade.authentication.listSnapTradeUsers();
  console.log('Users after:', after.data);
  console.log(
    'Deletion is queued asynchronously — users may take a moment to disappear.',
  );
} catch (err) {
  console.error('Failed:', err?.response?.data ?? err.message ?? err);
  process.exit(1);
}
