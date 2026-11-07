# Privacy and configuration

This export contains source and build metadata, not a user's application state. API credentials, paired-device tokens, conversation databases, contact lists, screenshots, voice references, agent authentication, and runtime profiles are not exported. The generated environment example contains empty secret values; it is documentation, not an automatically loaded credential store.

Keep private configuration and imported assets out of Git. Select a fresh absolute CAPRI_PROFILE_DIR for development. Configure any cloud provider yourself and understand what requests it receives. The export does not grant computer access, approve messages/calls, activate accounts, install hooks, or send API requests. Provider services and dependencies have their own terms.

The reviewed file manifest is an explicit release allowlist, not a secret detector guarantee. Content scans reject common credentials and absolute user paths without echoing matches. Human provenance/privacy review and platform checks remain required before publication. Inspect every hash-bound source change and keep historical code notices intact.
