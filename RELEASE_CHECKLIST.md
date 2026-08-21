# Release checklist

Run through this before dispatching the **Deploy production** workflow (see
[README.md#cicd](README.md#cicd)). CI already re-runs `npm run check` at
deploy time; this checklist covers what CI cannot verify automatically.

## 1. Deployed-header verification

CI validates the security header policy against source
(`tests/unit/security-render-and-headers.test.ts`), not against the live
deployment. After a deploy, confirm the headers actually reached
production:

```bash
curl -sI https://lyta.parthrohit-dev.workers.dev | grep -i \
  -e content-security-policy \
  -e x-content-type-options \
  -e referrer-policy \
  -e permissions-policy
```

Compare against `CONTENT_SECURITY_POLICY` and the rest of the policy in
`src/utils/browserSecurity.ts`.

## 2. Migration review

If this release adds a new Durable Object SQLite migration tag in
`wrangler.jsonc`:

- Confirm the migration is additive (new tag, new class) rather than a
  rename/delete of an existing class — those require the corresponding
  `deleted_classes`/`renamed_classes` entry and cannot be reverted.
- Confirm any storage-shape change in the affected DO (`src/durable/*.ts`)
  has a migration/backfill path for records written under the old shape
  (see the legacy-record migration pattern in `Workspace.loadLibrary()`
  and `Conversation.loadCanonicalHistory()`).
- Confirm rollback means reverting the Worker script, not the migration
  tag — Durable Object migrations are forward-only.

## 3. AI-evaluation comparison

Before promoting a model or prompt change (`src/config/modelProfiles.ts`,
`src/chat/messages.ts`'s system prompts):

- Run [`eval/dataset.json`](eval/dataset.json)'s cases against the current
  production model and the candidate, following
  [`eval/README.md`](eval/README.md#running-against-a-real-model)'s manual
  procedure — CI's automated run of this suite (`npm run test:eval`) only
  checks pipeline correctness against a scripted fake model, not real
  output quality.
- Compare citation accuracy, insufficient-evidence compliance, latency, and
  estimated cost against `MODEL_PROFILES`' documented `targets` in
  `src/config/modelProfiles.ts` (`recordOperation`'s `estimatedSpendUnits`
  in `src/utils/telemetry.ts` gives a rough cost proxy).
- Do not describe the candidate as "stronger" unless it meets or exceeds
  the baseline on every dimension above — see `eval/README.md`'s promotion
  policy.
- This is a lightweight version of the full cross-model evaluation and
  promotion policy tracked in
  [issue #16](https://github.com/parthrohit22/lyta/issues/16), which adds
  broader fixtures once Architecture Change Review and Drift Detection
  ship.

## 4. Manual accessibility smoke test

Automated checks don't cover interaction or assistive-technology
behavior. Against a local `wrangler dev` run or the deployed preview:

- Tab through the workspace rail, chat input, mode selector, and output
  board using only the keyboard — every interactive element must be
  reachable and show a visible focus state.
- Confirm form inputs (`pages/index.html`) have associated labels and
  that streamed chat responses are announced (or at least don't trap
  focus) by a screen reader.
- Spot-check color contrast on the chat surface and output board against
  WCAG AA (4.5:1 for body text) in both light and dark modes if
  supported.
