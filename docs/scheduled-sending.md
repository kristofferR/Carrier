# Scheduled sending

Write a message, then select the clock immediately to the left of the smiley.
Choose a quick delay or **Choose date & time**. Times use the local timezone and
24-hour `HH:mm` format. The custom picker starts ten minutes from now. The clock
follows the conversation's icon color and appears only while text is entered.

After confirmation, Carrier saves the message locally and clears the composer.
It submits the message automatically at the chosen time. You do not need to
press Enter or keep the conversation open. Carrier must be running, signed in
to the same account, and connected to Messenger.

The clock's dot indicates saved messages. Open it to edit a send time, cancel a
message, or copy its text. Scheduling currently supports text only, up to 2,000
characters. The clock disappears while a photo, video, or other unsupported
attachment is in the composer. It returns after the attachment is removed.

## Missed times

Carrier allows **two minutes of grace**. A message scheduled for 18:00 may be
submitted through 18:02, but never afterward. If Carrier was closed, offline,
unable to verify Messenger's connection, or unable to safely use the composer,
it keeps the message as **Not sent** and shows a desktop warning and an in-app
warning toast. If the app was closed, the warning appears on reopening. It does
not automatically reschedule the message.

Existing drafts, attachments, and ongoing calls are preserved. They may block
a scheduled send until the grace window expires. Leave the main window's
composer clear when expecting scheduled delivery. Scheduling is unavailable
with experimental multiple app instances enabled.

If Carrier exits during submission or cannot confirm Messenger accepted it,
the message is marked **Send unconfirmed** and is never automatically retried.
Check the conversation before rescheduling it to avoid duplicates.

The deadline controls when Carrier submits to Messenger. Once Messenger has
accepted a message, its network queue and the recipient's availability control
arrival; Carrier cannot retract an accepted message if the connection then drops.

## Persistence and recovery

The native queue lives in `scheduled-messages.json` in Carrier's app config
directory. It contains message text, account and conversation IDs, and send times.
It is local to this installation, is not cloud synced, and is not encrypted at
rest. On Unix systems the file is created with owner-only permissions.

A message is saved as an inactive draft first. It becomes eligible only after
the composer is cleared and the native queue acknowledges activation. Before
submission, Carrier persists an exclusive claim. A crash or lost acknowledgement
cannot turn that claim into an automatic retry. Native and page code both enforce
the same original deadline, including after sleep, reload, and app restart.
