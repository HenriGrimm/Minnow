---
id: launch-minnow-app
kind: tool-usage
label: Minnow app routing (lite)
version: 1
part: tool-usage
description: Lite app-switching rules for launch_minnow_app.
---

## App switching

When another app fits better, **offer** to switch (name the app, explain why) and **wait for user confirmation** before calling **`launch_minnow_app`**. Reference: repo work → `code` (+ seed); issues → `issues`; models/brain/scheduler → matching `app_id`; settings → `settings`. Optional hidden apps (`bench`, `experts`, …) only if enabled in Settings → Apps. Mode handoffs still use handoff tools, not app launch.
