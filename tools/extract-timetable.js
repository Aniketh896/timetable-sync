#!/usr/bin/env node
/**
 * Renders the Term V timetable web app and extracts its table to CSV.
 *
 * WHY A RENDERER IS NEEDED
 * ------------------------
 * The app's page body is just `<div id="table"></div>`; the rows are produced by a
 * client-side `google.script.run.getSheetData()` call. UrlFetchApp has no JS engine,
 * so from Apps Script the page is always empty — that is why the tool cannot fetch
 * this URL directly. A real browser runs that call; this drives one.
 *
 * NO SIGN-IN REQUIRED
 * -------------------
 * The app is published openly and its data loads for anonymous visitors, so this
 * launches its own throwaway Chrome profile. Nothing is logged in, no cookie or
 * credential is stored, and it does not touch your own browser profile.
 *
 * TWO THINGS THAT MAKE IT WORK, BOTH EASY TO GET WRONG
 * ----------------------------------------------------
 * 1. Apps Script renders user HTML inside a sandboxed cross-origin iframe. Page JS
 *    and bookmarklets cannot read into it; a DevTools-protocol driver can, because
 *    same-origin policy does not bind it. But the content lands in a NESTED child
 *    frame whose URL is not `userCodeAppPanel` — so selecting the frame by URL finds
 *    an empty shell. Every frame is searched instead.
 * 2. Google wraps the sandbox in its own 1x1 layout `<table>` for the "Report abuse"
 *    banner. Taking the first table found returns that banner. Candidate tables are
 *    scored by rows x columns and the largest wins.
 *
 * USAGE
 *   npm install puppeteer-core
 *   node extract-timetable.js
 *
 * Writes timetable.csv next to this script and copies it to the clipboard as TSV, so
 * it can be pasted straight into the ManualTimetable tab (paste lands in cells).
 * Verified 2026-08-28: 1063 rows x 5 columns, 14 Sep – 29 Nov 2026, 28 course codes.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const puppeteer = require('puppeteer-core');

// Every institute schedule published as an Apps Script app, with the paste tab each
// one belongs in. Pass a name to extract just that one: `node extract-timetable.js guest`.
const APPS = [
  {
    name: 'timetable', tab: 'ManualTimetable',
    id: 'AKfycbyALiIAKX30Vrwqb6fOvxXR5i66vnfe4-DCfhnEAY_g59FX_OyaobPYkSwZ2sRwX62fAQ'
  },
  {
    name: 'guest', tab: 'ManualGuest',
    id: 'AKfycbwwNuTB8-VskKcf3Tkt0oOJGWojOqOud50h3eocGNO7sEQPR57lgp3yPpDA_TlFRlsz9Q'
  },
  {
    name: 'feedback', tab: 'ManualFeedback',
    id: 'AKfycbzdGDiFRQ3qsRZyhEsjSA6EvZV4uPcubS5A64U8NoP_MUg3uYWPx4Ytd1Pi4PRa-cwM4Q'
  },
  {
    name: 'catalogue', tab: '(reference only — updates COURSE_INFO_)',
    id: 'AKfycbwh9rMbmdwhizZ4aD8KRkrVxmDzHCJRj_OLSlcpfqj2Ty6BvTuEqvVz984Gmb6po0x4SA'
  },
];
const RENDER_TIMEOUT_MS = 60000;

// Common Chrome locations; override with CHROME_PATH=... if yours is elsewhere.
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Program Files/Google/Chrome/Application/chrome.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
].filter(Boolean);

const csvCell = v => {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

function findChrome() {
  for (const p of CHROME_CANDIDATES) { if (fs.existsSync(p)) return p; }
  throw new Error(
    'Could not find Chrome. Set CHROME_PATH to its executable, e.g.\n' +
    '  CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node extract-timetable.js');
}

async function extractOne(browser, app) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });
  try {
    await page.goto('https://script.google.com/macros/s/' + app.id + '/exec',
      { waitUntil: 'networkidle2', timeout: RENDER_TIMEOUT_MS });

    let rows = null;
    const deadline = Date.now() + RENDER_TIMEOUT_MS;
    while (Date.now() < deadline && !rows) {
      let best = null, bestScore = 0;
      for (const frame of page.frames()) {
        let candidates;
        try {
          candidates = await frame.evaluate(() =>
            [...document.querySelectorAll('table')].map(t =>
              [...t.querySelectorAll('tr')].map(tr =>
                [...tr.querySelectorAll('td,th')].map(td =>
                  td.innerText.replace(/\u00a0/g, ' ').trim()))));
        } catch (e) {
          continue; // frame detached mid-navigation
        }
        for (const c of candidates || []) {
          if (!c || c.length < 2) continue;
          const width = c.reduce((m, r) => Math.max(m, r.length), 0);
          if (width < 2) continue;             // skips Google's 1x1 banner wrapper
          const score = c.length * width;
          if (score > bestScore) { bestScore = score; best = c; }
        }
      }
      if (best) rows = best; else await new Promise(r => setTimeout(r, 700));
    }
    if (!rows) return { app, error: 'no table rendered within ' + (RENDER_TIMEOUT_MS / 1000) + 's' };

    const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
    const square = rows.map(r => { const c = r.slice(); while (c.length < width) c.push(''); return c; });
    const out = path.join(__dirname, app.name + '.csv');
    fs.writeFileSync(out, square.map(r => r.map(csvCell).join(',')).join('\n') + '\n', 'utf8');
    return { app, rows: square, width, out };
  } finally {
    await page.close().catch(() => { });
  }
}

async function main() {
  const only = process.argv[2];
  const wanted = only ? APPS.filter(a => a.name === only) : APPS;
  if (!wanted.length) throw new Error('Unknown app "' + only + '". Try: ' + APPS.map(a => a.name).join(', '));

  const exe = findChrome();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-extract-'));
  const browser = await puppeteer.launch({
    executablePath: exe, headless: 'new', userDataDir: profile,
    // --no-sandbox is required on CI runners (Chrome's sandbox needs privileges the
    // runner doesn't grant) and is scoped to CI only, since it weakens the sandbox.
    // --disable-dev-shm-usage avoids Chrome running out of shared memory in a
    // container, which shows up as a mid-render crash rather than a clear error.
    args: ['--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage']
      .concat(process.env.CI ? ['--no-sandbox'] : []),
  });

  const results = [];
  try {
    for (const app of wanted) {
      process.stdout.write('Rendering ' + app.name + '… ');
      const r = await extractOne(browser, app);
      results.push(r);
      console.log(r.error ? 'FAILED (' + r.error + ')' : r.rows.length + ' rows x ' + r.width + ' cols');
    }
  } finally {
    await browser.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }

  console.log('');
  for (const r of results) {
    if (r.error) continue;
    console.log(r.app.name + '  ->  ' + r.out);
    console.log('   header: ' + JSON.stringify(r.rows[0]));
    console.log('   paste into: ' + r.app.tab);
  }

  // Only the timetable goes to the clipboard — it is the one that always needs pasting,
  // and a clipboard can hold one thing.
  const tt = results.find(r => r.app.name === 'timetable' && !r.error);
  if (tt) {
    const tsv = tt.rows.map(r => r.join('\t')).join('\n');
    try {
      if (process.platform === 'darwin') execSync('pbcopy', { input: tsv });
      else if (process.platform === 'win32') execSync('clip', { input: tsv });
      console.log('\nTimetable copied to clipboard as TSV — paste over cell A1 of ManualTimetable.');
    } catch (e) { console.log('\n(Clipboard unavailable — use the CSV files.)'); }
  }
  console.log('Then run "Test timetable source" from the sheet\'s Tool Stats menu.');

  // Exit non-zero when the TIMETABLE fails, so a scheduled run fails visibly instead
  // of quietly pushing whatever it managed. The other schedules are optional — a
  // missing guest lecture list is a normal state, not a broken run.
  const ttFailed = results.find(r => r.app.name === 'timetable' && r.error);
  if (ttFailed) {
    console.error('\nTimetable extraction FAILED: ' + ttFailed.error);
    process.exitCode = 1;
  }
}

main().catch(e => { console.error('\n' + e.message + '\n'); process.exit(1); });
