---
"@moonshot-ai/kimi-code": patch
---

Show Kimi plan quota in the footer: one progress bar per limit (5-hour and weekly) with reset times and a refresh stamp, updated every minute when logged in with a Kimi subscription. Add `usage` to `[status_line].items` in `tui.toml` to also pin the weekly percentage to the first footer line; custom status line commands receive the quota as `managedUsage` in their JSON snapshot.
