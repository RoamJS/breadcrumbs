# Breadcrumbs

RoamJS extension that shows clickable navigation breadcrumbs in the Roam top bar.

## Features

- Tracks recently visited pages and block locations
- Renders oldest-to-current breadcrumb trail in the top bar
- Click any non-current breadcrumb to navigate back
- Distinguishes pages vs blocks with different styles
- Supports Blueprint dark mode (`.bp3-dark`)

## Settings

- `Enable breadcrumbs`: turn the extension on/off
- `Max breadcrumbs`: max number of prior locations to keep
- `Truncate length`: max label length before truncation

## Development

```bash
npm install
npm start
```

Build dry-run for Roam:

```bash
npm run build:roam
```
