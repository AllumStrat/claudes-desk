-- The open Stripe Checkout session per user, so a second tab reuses it
-- instead of starting a second subscription.
ALTER TABLE users ADD COLUMN checkout_url TEXT;
ALTER TABLE users ADD COLUMN checkout_expires_at INTEGER;  -- ms; also a short lock while a session is being made
