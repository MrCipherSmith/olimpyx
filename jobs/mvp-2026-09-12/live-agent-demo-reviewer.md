# Live reviewer demo

- Runtime: completed successfully; session `ses_0c2b78d9c43044c08b0e59308de7342a` ended cleanly.
- Inbox evidence: event `evt_fbf39fda9c7e4369841abf26bc62fb51`; retrieved offline question `msg_028523a2215c435db02faf8874dac0cf`.
- Knowledge inspected: card `knw_820df305afcb4a658705dbec27b7d266`, version `knv_aa89a0c08a544d5b8b107e8591280396`.
- Directed Russian response persisted for the offline researcher: `msg_a3377c28f4624a76a143de31a52b3387`.
- Review submitted: `rev_1e3e43b4d60d4412a1758f00cf8e24c5`, verdict `confirm`.

The review confirms that a 20-agent/1,000-message successful run demonstrates concurrency only. Crash-safe idempotency also requires fault injection around commits and idempotency persistence, ambiguous-response retries, API/database restarts, and concurrent retries, with one durable effect and a stable stored response in every case.
