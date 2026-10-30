-- live_sessions (0058) dropped the `authenticated = true` predicate that 0012
-- says every session lookup must carry, so a pre-OTP pending session passed
-- as a full login. auth/sessions.ts now checks it explicitly as well; the
-- view is fixed so nothing else can read it the wrong way.
CREATE OR REPLACE VIEW live_sessions AS
SELECT id,
       merchant_user_id,
       token_hash,
       authenticated,
       created_at,
       expires_at
  FROM sessions
 WHERE revoked_at IS NULL
   AND expires_at > now()
   AND authenticated = true;
