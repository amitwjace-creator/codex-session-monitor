# Roadmap

## Near Term

- Add more Codex JSONL fixtures as new event shapes are observed.
- Add configurable completion-log retention.
- Add custom alarm sounds.
- Add optional desktop notifications from the Node backend for systems where browser notifications are disabled.

## Tray App

A tray build would make the monitor feel native:

- System tray icon with current state
- Background start on login
- Native dismiss action
- Native notification click-to-focus
- Packaged installers for Windows, macOS, and Linux

Tauri is the likely fit because the app is already a small local web UI with a compact local monitoring layer.

## Stats

- Small charts for task duration over time
- Token usage history
- Daily/weekly completion counts
- Session filtering and CSV export

## Reliability

- Optional support for a future official Codex status API if one becomes available
- More defensive parsing for partial JSONL writes and schema changes
- Integration tests that simulate file updates while the monitor is running
