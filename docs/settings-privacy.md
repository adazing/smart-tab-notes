# Ticket #10 implementation record

Branch: `arielle/settings-privacy`, created after `git pull --ff-only origin main`.
Base: `ce263d5aaa1173f0790b91ea484b4cdda1c595dc` (latest fetched `origin/main`).
No commits, pushes, or PRs were made.

## Files

Created:

- `src/shared/privacy.ts`: settings, domain validation/matching and subscriptions.
- `src/shared/privacy.test.ts`: defaults, normalization, boundary matching and fail-closed behavior.
- `src/shared/tabs.test.ts`: privacy filtering for tabs and groups.
- `src/background/privacy.test.ts`: serialized persistence, add/remove/duplicates, failures, onboarding and sender enforcement.
- `src/sidepanel/views/SettingsView.tsx`: blocklist, deletion confirmations and privacy link.
- `src/sidepanel/views/PrivacyView.tsx`: first-run and reopened privacy information.
- `src/sidepanel/settings.test.ts`: confirmation, cancellation, deletion errors and onboarding/navigation.
- `docs/settings-privacy.md`: this implementation record.

Modified:

- `README.md`: settings usage, enforcement, deletion policy, testing and integration notes.
- `src/background/index.ts`: initialization, settings mutations, privacy boundaries and invalidation.
- `src/content/index.ts`: protected context/selection handlers and deletion invalidation.
- `src/content/toolbar.ts`: live privacy gating and dismissal.
- `src/content/toolbar.test.ts`: blocking and unblocking coverage.
- `src/extract/index.ts`: expose shared privacy check in injected reader.
- `src/shared/messages.ts`: typed settings/invalidation messages and outgoing privacy checks.
- `src/shared/storage.ts`: transactional permanent page-annotation and all-data deletion.
- `src/shared/storage.test.ts`: physical deletion, isolation and rollback coverage.
- `src/shared/tabContext.ts`: pre-injection, in-page and final privacy checks.
- `src/shared/tabContext.test.ts`: mixed/direct blocked IDs, mid-flight changes and onboarding.
- `src/shared/tabs.ts`: eligible tab filtering.
- `src/shared/types.ts`: Settings navigation.
- `src/sidepanel/App.tsx`: settings/onboarding and content invalidation.
- `src/sidepanel/styles.css`: compact responsive settings and destructive controls.
- `src/sidepanel/usePageState.ts`: privacy refresh and stale selection clearing.
- `src/sidepanel/views/ThisPageView.tsx`: privacy-aware restriction message.
- `tests/browser/toolbar.spec.ts`: onboarding setup and packaged privacy flow.

## Verification

- `npm test`: 88 tests passed across 9 files.
- `npm run typecheck`: passed (also run by production build).
- `npm run build`: passed, including packaged manifest verification.
- `npm run test:browser`: 2 passed; 5 external-site tests intentionally skipped.
- `git diff --check`: passed.
- No lint command is configured.
- Existing lockfile dependencies installed with `npm ci`; no new dependencies or secrets added.

Chromium browser automation loaded the actual packaged extension in a temporary
profile. It verified onboarding, toolbar interactions and isolation, default
blocklist display, adding a normalized domain, live toolbar dismissal, blocked
extraction, persistence after panel reload, removal/unblocking, successful actual
extraction after unblocking, cancellation of the all-data confirmation, and
reopening privacy information. These were automated tests, not manual Chrome
side-panel tests. Browser tests opened the panel HTML as an extension tab.
Current-page and all-data deletion, cancellation, failures and rollback were
verified by unit/UI tests. No manual browser tests were performed.

## Limits and demonstration

No PRD was supplied. Blocklist and onboarding preferences are intentionally
preserved by deletion. Saved content is physically deleted from existing Dexie
tables; temporary toolbar UI is invalidated too. No sync or AI frontend requests
exist. The toolbar still uses temporary saves until Ticket #6. The tab picker
and selected-tab state do not exist; shared listing/group filtering is implemented
and the README documents subscription and selected-ID reconciliation for its
future consumer. Future AI/sync code must use these privacy/deletion boundaries.

For Sunday's demo, load `dist/` unpacked in Chrome, open the panel, complete
onboarding, and choose Settings. Show the starter domains; add an open demo
site, confirm its toolbar disappears and extraction is restricted, then unblock
it and extract again. Reopen the panel to show persistence. Show both deletion
confirmations and Cancel; use seeded saved records to demonstrate confirmed
per-page and all-data deletion. Reopen Privacy information from Settings.
