# Per-channel deadline reminder delivery

Scope: the user authorized a targeted backend repair after an owner notification
was found to suppress retries to the student. No deadline data, roadmap rules,
chat/document-check APIs, portal authentication, prices, secrets or infrastructure
are changed. This is Telegram/email delivery to already linked/opted-in clients,
not SMS or WhatsApp. Related frontend PR: bashpayy-hash/iitaly-site#34.

## Delivery and retry behavior

`reminders.js` stores `client.reminderDelivery` inside the existing encrypted
client file. Student Telegram, student email and owner Telegram have independent
receipts and retry states. A successful owner or email send cannot acknowledge
student Telegram. Successful sends are persisted after each channel, not after
all recipients have finished. The existing `/api/reminders/run` contract keeps
`ok`, `checked`, `sent`; additional diagnostic counters contain no personal data.

A 15-minute scheduler tick replaces the previous daily tick. Failed channels back
off 15m, 30m, 1h, 2h, 4h, then at most once per 6h while still eligible. A provider
`retry_after` can extend that delay. Explicit Telegram configuration/blocked-chat
errors wait at least 24h. Flood-control responses also pause other Telegram sends
in the current process; email remains independent. There is no busy retry loop.
`REMINDERS=off` still disables automatic runs; the first enabled run is delayed
one minute. Timer and manual requests share a single in-flight job.

Current 7/3/1-day urgency bands and one overdue notice are identified by task ID,
exact deadline and band, rather than only task ID. Retrying at one day remaining
does not send three successive 7/3/1 notices. Moving a deadline produces a new
identity. Failed outdated bands are replaced with the current urgency. Completed
or removed tasks and invalid/absent dates are never sent. Only the first six
urgent tasks actually present in a message are marked; remaining tasks stay due.
Monday digests have a per-channel/week key; a failed digest may retry later in the
same week with up-to-date tasks. The calendar timezone follows the existing
server/roadmap timezone; no new deadline source or guarantee of official dates
has been introduced.

Telegram success requires HTTP success, JSON `ok:true` and a message ID. Timeout
covers reading the response body, too. SMTP success requires acceptance of the
actual intended recipient. These are **provider acceptance receipts**, not proof
that a phone displayed a push notification or that the student read it.

Provider references consulted for the adapter:
- https://core.telegram.org/bots/api#making-requests
- https://core.telegram.org/bots/api#responseparameters
- https://core.telegram.org/bots/api#sendmessage

## Safe persistence and opt-out

After awaiting the provider, the runner re-reads the client and updates only the
reminder ledger. It does not overwrite new tasks/documents, relink an opted-out
Telegram chat, or recreate a deleted client. Each channel state includes a target
fingerprint, so receipts from a previous chat/email do not acknowledge a new one.
Reminder-only writes use a temporary file and same-directory rename, retaining
the existing encryption format. A write error leaves the old client file intact.
Acknowledged sends awaiting persistence are buffered in memory; the next tick
retries persistence before attempting additional sends. Logs contain aggregate
counts/generic failure messages, not tokens, customer names or recipient IDs.
Student messages link to `/portal`, without embedding the access code.

## Legacy history

The old `client.reminded` map cannot tell who received a notification. It is
retained, not deleted. On first use, its marks are copied into a separate
**legacySuppressed** set tied to the current roadmap deadlines. This avoids a
bulk replay of historical reminders. Those marks are NOT claimed as successful
student delivery. Historical missed messages cannot be reliably reconstructed
from this data; no mass recovery send or production migration script is run.
Future unmarked urgency bands and changed deadlines use the new independent
receipts. Unknown/corrupted ledger versions fail closed rather than resetting
history and silently resending everything.

## Limits and rollout

This is a single-process scheduler over the existing file store, appropriate to
the currently configured single replica. Before scaling horizontally, use a
transactional shared outbox and distributed claiming. The HTTP provider send and
local write cannot be atomic: a crash after acceptance but before persistence,
or an ambiguous network timeout, can still produce a duplicate after restart.
There is no claim of exactly-once delivery or guaranteed phone notifications.
An atomic rename does not replace backups or a persistent Railway volume.

Before production rollout: confirm the persistent volume/backup and single-replica
configuration, review both backend and frontend PRs, and use an explicitly
consenting test account for one real opt-in/notification/opt-out acceptance test.
Do not call the global reminder endpoint just to test a single client. Do not
clear old history or rotate DATA_KEY. No production tokens, client files, webhook
settings, reminders endpoint or real recipients were accessed by these tests.
Rollback: preserve the full client file/ledger backup. The old code ignores the
new ledger; rolling back while reminders are enabled may repeat newer sends.

## Verification

`node --test test/*.test.js` runs offline with synthetic clients, clocks and
intercepted transports. Tests cover owner-only/email-only success; retry and
restart; backoff/rate limits; opt-out during an in-flight send; changed targets;
completed/deleted clients; legacy migration; changing dates; weekly digests;
partial batches; overlapping runs; invalid responses/body timeout; encrypted
storage; atomic-write failures; existing portal and webhook handlers; and timer
wiring. CI also retains the existing syntax and HTTP smoke checks, with
`REMINDERS=off`, a temporary DATA_DIR and no production credentials.
