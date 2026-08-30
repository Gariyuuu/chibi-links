/*
 * chibi-links end-to-end suite.
 * Self-contained: spins up its own static server on an ephemeral port,
 * serves ../index.html plus a synthetic /target.html landing page, and
 * drives the app with Playwright (chromium).
 *
 *   npm install && npx playwright install chromium && npm test
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'index.html'));
const TARGET = '<!DOCTYPE html><title>landed</title><h1 id="landed">landed</h1>';

const results = [];
function ck(name, cond) { results.push([cond ? 'PASS' : 'FAIL', name]); }

(async () => {
  const server = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (p === '/' || p === '/index.html') res.end(INDEX);
    else if (p === '/target.html') res.end(TARGET);
    else { res.statusCode = 404; res.end('nope'); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const BASE = 'http://127.0.0.1:' + server.address().port;

  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  const page = await ctx.newPage();

  // ── 1. create → resolve → redirect, clicks exactly once ──
  await page.goto(BASE + '/index.html');
  await page.fill('#url', BASE + '/target.html?x=1');
  await page.click('#go');
  await page.waitForSelector('#tbody tr[data-code]');
  const code = await page.getAttribute('#tbody tr', 'data-code');
  const toastText = await page.textContent('#toast');
  ck('create: row appears + copy toast', !!code && /copied → .*#/.test(toastText));
  const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
  ck('create: short link auto-copied to clipboard', clip === BASE + '/index.html#' + code);

  await page.goto(BASE + '/index.html#' + code);
  const sawInterstitial = await page.waitForSelector('#view-redirect:not([hidden])', { timeout: 1000 }).then(() => true).catch(() => false);
  await page.waitForURL('**/target.html*', { timeout: 4000 });
  ck('resolve: interstitial then auto-redirect via replace', sawInterstitial && page.url().includes('/target.html?x=1'));

  await page.goto(BASE + '/index.html');
  const clicks1 = (await page.textContent('#tbody tr .c-clicks')).trim();
  ck('clicks incremented exactly once', clicks1 === '1');
  const stat = await page.textContent('#stat');
  ck('header stat shows 1 link · 1 total redirect', /1 link · 1 total redirect$/.test(stat.trim()));

  // ── 2. unknown code → designed 404, back without reload ──
  await page.evaluate(() => { window.__marker = 42; location.hash = '#zzzzz'; });
  await page.waitForSelector('#view-404:not([hidden])');
  ck('404: view shown on hashchange without reload', await page.evaluate(() => window.__marker === 42));
  ck('404: shows the missing code', (await page.textContent('#nf-code')).trim() === '#zzzzz');
  await page.click('#nf-back');
  const afterBack = await page.evaluate(() => ({ h: location.hash, m: window.__marker, creator: !document.getElementById('view-creator').hidden }));
  ck('404: back clears hash, no reload, creator intact', afterBack.h === '' && afterBack.m === 42 && afterBack.creator);

  // ── 3. alias handling ──
  await page.fill('#url', BASE + '/target.html?alias=1');
  await page.fill('#alias', 'My Link!');
  const aliasVal = await page.inputValue('#alias');
  ck('alias: "My Link!" live-lowercased/stripped to "mylink"', aliasVal === 'mylink');
  await page.click('#go');
  await page.waitForSelector('#tbody tr[data-code="mylink"]');
  ck('alias: custom alias accepted and used as code', true);
  await page.fill('#url', BASE + '/target.html?alias=2');
  await page.fill('#alias', 'mylink');
  await page.click('#go');
  ck('alias: duplicate alias → "err: alias taken"', (await page.textContent('#err')).trim() === 'err: alias taken');
  await page.fill('#alias', '');

  // ── 4. javascript: rejected + inert even if force-stored ──
  await page.fill('#url', 'javascript:alert(1)');
  await page.click('#go');
  ck('security: javascript: → "err: http(s) only"', (await page.textContent('#err')).trim() === 'err: http(s) only');
  await page.evaluate(() => {
    // force-store a hostile url, bypassing validation, then visit its code
    const s = JSON.parse(localStorage.getItem('chibi-links-v1'));
    s.links['evil1'] = { url: 'javascript:window.__pwned=1', createdAt: 1 };
    localStorage.setItem('chibi-links-v1', JSON.stringify(s));
  });
  await page.goto(BASE + '/index.html?fresh=1#evil1'); // query change forces a real reload so the injected store is read
  await page.waitForSelector('#view-redirect:not([hidden])');
  await page.waitForTimeout(1200);
  const pwned = await page.evaluate(() => ({ p: window.__pwned, href: document.getElementById('r-btn').getAttribute('href'), still: location.href }));
  ck('security: stored javascript: url is inert (no exec, href=#, no nav)', !pwned.p && pwned.href === '#' && pwned.still.includes('#evil1'));
  await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('chibi-links-v1')); delete s.links.evil1; localStorage.setItem('chibi-links-v1', JSON.stringify(s)); });

  // ── 5. duplicate target returns existing code ──
  await page.goto(BASE + '/index.html');
  const rowsBefore = await page.locator('#tbody tr[data-code]').count();
  await page.fill('#url', BASE + '/target.html?x=1'); // same target as link #1
  await page.click('#go');
  await page.waitForSelector('#toast:not([hidden])');
  const dupToast = await page.textContent('#toast');
  const rowsAfter = await page.locator('#tbody tr[data-code]').count();
  ck('duplicate target: existing code returned, no new row', rowsAfter === rowsBefore && dupToast.includes('#' + code) && dupToast.includes('already minted'));

  // ── 6. delete → old code 404s, count gone ──
  const delRow = page.locator('#tbody tr[data-code="mylink"]');
  await delRow.locator('button.del').click();
  ck('delete: first click arms to "sure?"', (await delRow.locator('button.del').textContent()) === 'sure?');
  await delRow.locator('button.del').click();
  await page.waitForTimeout(100);
  ck('delete: second click removes row', (await page.locator('#tbody tr[data-code="mylink"]').count()) === 0);
  await page.evaluate(() => { location.hash = '#mylink'; });
  await page.waitForSelector('#view-404:not([hidden])');
  const clicksGone = await page.evaluate(() => !('mylink' in JSON.parse(localStorage.getItem('chibi-links-v1')).clicks));
  ck('delete: old #code → 404, click count purged from store', clicksGone);

  // ── 6b. delete arm reverts after 3s ──
  await page.evaluate(() => { history.replaceState(null, '', location.pathname); });
  await page.goto(BASE + '/index.html');
  const r1 = page.locator('#tbody tr[data-code]').first();
  await r1.locator('button.del').click();
  await page.waitForTimeout(3300);
  ck('delete: "sure?" reverts to "del" after 3s', (await r1.locator('button.del').textContent()) === 'del');

  // ── 7. clipboard API absent → fallback still gives "copied ✓" ──
  const page2 = await ctx.newPage();
  await page2.addInitScript(() => Object.defineProperty(Navigator.prototype, 'clipboard', { get: () => undefined }));
  await page2.goto(BASE + '/index.html');
  await page2.waitForSelector('#tbody tr[data-code]');
  await page2.locator('#tbody tr button.copy').first().click();
  await page2.waitForTimeout(200);
  ck('clipboard absent: fallback path shows "copied ✓"', (await page2.locator('#tbody tr button.copy').first().textContent()) === 'copied ✓');
  await page2.close();

  // ── 8. no transparent backgrounds (white-host embed) ──
  const transparent = await page.evaluate(() => {
    const bad = [];
    for (const el of document.querySelectorAll('body,section:not([hidden]) *')) {
      const cs = getComputedStyle(el);
      if (el.closest('[hidden]')) continue;
      // structural containers must paint; inline text spans inherit painted parents
      if (['DIV', 'SECTION', 'TABLE', 'TD', 'TH', 'FORM', 'HEADER', 'FOOTER', 'BODY', 'INPUT', 'BUTTON'].includes(el.tagName)) {
        if (cs.backgroundColor === 'rgba(0, 0, 0, 0)' && !el.id.includes('carrier')) bad.push(el.tagName + '#' + el.id + '.' + el.className);
      }
    }
    return bad;
  });
  ck('embed: structural elements all paint explicit backgrounds (' + (transparent.length ? 'leaks: ' + transparent.slice(0, 3).join(', ') : 'none') + ')', transparent.length === 0);

  // ── 9. hashchange to a live code while open → interstitial, no reload ──
  const live = await page.getAttribute('#tbody tr', 'data-code');
  await page.evaluate(() => { window.__m2 = 7; });
  await page.evaluate(c => { location.hash = '#' + c; }, live);
  const gotInter = await page.waitForSelector('#view-redirect:not([hidden])', { timeout: 1000 }).then(() => true).catch(() => false);
  const noReload = await page.evaluate(() => window.__m2 === 7);
  ck('hashchange live: interstitial appears without reload', gotInter && noReload);
  await page.click('#r-cancel');
  ck('interstitial: cancel returns to creator + clears hash', await page.evaluate(() => location.hash === '' && !document.getElementById('view-creator').hidden));

  // ── 10. validation basics ──
  await page.fill('#url', '');
  await page.click('#go');
  ck('validation: empty url → "err: paste a url first"', (await page.textContent('#err')).trim() === 'err: paste a url first');
  await page.fill('#url', 'a b c');
  await page.click('#go');
  ck('validation: garbage → "err: that\'s not a url"', (await page.textContent('#err')).trim() === "err: that's not a url");
  await page.fill('#url', 'example.com/no-scheme');
  await page.click('#go');
  await page.waitForTimeout(150);
  const prepended = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('chibi-links-v1')).links).some(l => l.url === 'https://example.com/no-scheme'));
  ck('validation: schemeless url gets https:// prepended', prepended);

  // ── 11. corrupt storage → fresh state, no crash ──
  await page.evaluate(() => localStorage.setItem('chibi-links-v1', '{corrupt!!'));
  await page.goto(BASE + '/index.html');
  ck('corrupt JSON in storage → fresh state, page renders', await page.evaluate(() => !document.getElementById('empty').hidden));

  await browser.close();
  server.close();
  let fails = 0;
  for (const [s, n] of results) { console.log(s + '  ' + n); if (s === 'FAIL') fails++; }
  console.log(fails === 0 ? 'ALL PASS (' + results.length + ')' : fails + ' FAILURES');
  process.exit(fails ? 1 : 0);
})().catch(e => {
  console.error('HARNESS ERROR:', e.message);
  for (const [s, n] of results) console.log(s + '  ' + n);
  process.exit(2);
});
