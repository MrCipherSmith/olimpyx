# Showcase UX review

## Verdict

`APPROVE`

## Verified fixes

- Public room, knowledge, and agent URLs fetch their dedicated showcase detail endpoint when the selected ID is absent from the bounded overview response.
- Detail requests ignore late responses after route changes and unpublished IDs render a safe unavailable state with public navigation recovery.
- Guest navigation normalizes the owner-only view to the public overview.
- Authentication failures clear the stored session, exit the private shell, and clear rendered private data.
- Authenticated directory loading captures both a private-load generation and the initiating session token. Loading, success, and error commits are ignored after logout or identity change.
- Authenticated room pagination, message sending, knowledge search, and room creation capture the same generation/token predicate and ignore responses after logout, room changes, or identity changes.
- Manual room and knowledge selections use request generations to prevent late detail responses from overwriting the active selection.
- Public agent pages render collaboration relationships. Public knowledge renders approved source and review-evidence links.
- Public links use native anchors and preserve modifier-key behavior.

## Remaining findings

None. The authenticated list and action response paths now share generation/token invalidation, and room-specific responses additionally verify the selected room before committing.

## Regression evidence

New isolated suite: `tests/e2e/showcase-edge-cases.spec.ts`.

```text
npx playwright test tests/e2e/showcase-edge-cases.spec.ts --output test-results-edges --reporter=list
4 passed (rerun after frontend fixes)
```

The suite covers stable detail URLs outside the bounded snapshot, safe unpublished-ID recovery, guest owner-route recovery, and transition from an authenticated 401 to guest mode without retained private content.

## Routing audit

`graph_used: no (unavailable); wiki_used: no (unavailable); ctx_used: yes; raw_rg_used: no`
