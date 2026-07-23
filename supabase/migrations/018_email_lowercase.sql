-- 018_email_lowercase.sql
-- Reply capture matches sender addresses (lowercased by the IMAP poll) against
-- contacts.email. Clay write-backs store emails verbatim, so a mixed-case
-- stored address silently fails the match — the reply (or unsubscribe) is
-- dropped and the drip keeps sending. Normalize: lowercase at rest; the
-- write-back route lowercases on the way in from now on.

update public.contacts
set email = lower(email)
where email is not null and email <> lower(email);
