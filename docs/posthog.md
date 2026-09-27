# Optional PostHog EU analytics

Uses the existing EU project token with app=zenflo. Filter by the app property; existing ProfitQuote events have no app property. Browser identities and consent are separate for each origin/app. No email, names, account IDs, input values or business/health content are sent as event properties. There is no cross-domain identity linking.

No PostHog SDK request is made until explicit opt-in. DNT/GPC suppress collection. Analytics choices can withdraw consent; other tabs receive the change. Existing Google tracking is preserved. Autocapture, console, network, errors and heatmaps are off. All text is masked; controls/media/forms and private product content are blocked. Admin, invite and password-reset routes are excluded. Session replay is intentionally unavailable for Callback dashboard/setup and blocks the Zenflo app and Kelvori workspace.

Events: page_viewed, trial_click, signup_screen_viewed, signup_attempted, signup_failed, account_created, login_completed and checkout_started where implemented. Callback adds setup_completed; Kelvori adds assessment_started/assessment_completed without answers/scores. Checkout started means intent only. This change does not claim or emit paid_conversion; verified webhook conversion delivery with durable consent/deduplication remains separate work.

Deploy by reviewing and merging this PR. No server secrets or new paid services are required. The shared PostHog project already has replay enabled, total privacy masking, and console/network disabled. Verify on the deployed origin: no SDK before opt-in; allow and inspect app-filtered events; decline and reload; inspect replay masking; test signup success/failure and checkout without charging. Roll back by reverting this PR.
