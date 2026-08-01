# Contributing

Thanks for helping improve Codex Session Monitor.

## Local Development

```powershell
npm start
```

Open `http://127.0.0.1:3786`.

Run syntax checks:

```powershell
npm run check
```

## Pull Requests

- Keep the app lightweight and local-first.
- Avoid adding runtime dependencies unless they clearly improve reliability.
- Do not commit local runtime data from `.data/`, `.runtime/`, or monitor log files.
- If you change the UI, update screenshots when the visual behavior changes.
- If you change status detection, include notes about which Codex event types are involved.

## Good First Issues

- Add macOS/Linux backend alarm support.
- Add configurable alarm patterns.
- Improve error state detection as more Codex event shapes are observed.
- Add small trend charts for task duration and usage.
