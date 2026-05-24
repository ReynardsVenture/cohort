# Open Questions (future — not blocking build)

Build v1 is implemented. Remaining product/legal decisions:

## Age verification — stronger method (future)

Launch uses `self_declared`. JMStV may require stronger verification later — pluggable via `age_verification_method` without schema churn.

## Paid tier SKUs (future)

Entitlements table supports tiers; no Stripe products hardcoded beyond env `STRIPE_PRICE_ID_PAID`. Decide whether paid value is extra sparks or non-scarcity conveniences.

---

*Implementation complete — deploy Supabase EU + configure secrets.*
