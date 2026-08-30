# chibi — serverless url shortener

One self-contained HTML file. No server, no framework, no build step — the
page's own URL fragment is the routing mechanism.

**Live:** see the Vercel deployment for this repo (or just open `index.html`).

## How it works

- **Create:** paste a URL (+ optional `[a-z0-9-]` alias). Generated codes are
  5 chars from `abcdefghjkmnpqrstuvwxyz23456789` — 0/O/1/l/i are deliberately
  excluded because codes get read aloud and retyped. Collisions regenerate up
  to 10×, then lengthen to 6 chars.
- **Short link:** `location.origin + location.pathname + "#" + code`, computed
  at runtime — works wherever the file is hosted, never hardcoded.
- **Resolve:** on load and on `hashchange`, a matching code switches to a
  redirect interstitial (600 ms progress bar → `location.replace`). A large
  manual button is always shown too, because sandboxed/embedded contexts can
  block programmatic navigation — the auto-attempt is a convenience, the
  button is the guarantee.
- **State:** `localStorage["chibi-links-v1"]` →
  `{ version, links: {code: {url, createdAt}}, clicks: {code: n} }`, with an
  in-memory fallback (and a visible banner) when storage is unavailable.

## Running the tests

The Playwright e2e suite (26 checks: routing, validation, security, clipboard
fallback, theming) starts its own static server — no setup beyond deps:

```sh
npm install
npx playwright install chromium
npm test
```

## Security notes

- Only `http:`/`https:` schemes can be stored — `javascript:` (and `data:`,
  etc.) are rejected at validation *and* re-vetted at resolve time, so a
  force-injected hostile URL is inert (tested).
- All rendered strings are escaped; hash codes are attacker-controlled, so
  store lookups go through `hasOwnProperty` (`#constructor` must not hit
  `Object.prototype`).

## Known limitations (by design)

- **Links only resolve in browsers sharing the localStorage that created
  them.** There is no server — a code minted on your laptop is invisible on
  your phone. It's a serverless toy, not bit.ly.
- Click counts accrue only in that same browser.
- Multi-tab on the same origin stays in sync via the `storage` event.
