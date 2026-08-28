#!/usr/bin/env node
/**
 * Writes the CSVs produced by extract-timetable.js into the "bridge" spreadsheet
 * that Apps Script reads.
 *
 * WHY A SEPARATE BRIDGE SHEET
 * ---------------------------
 * The service account needs Editor rights on whatever it writes to. The tool's own
 * spreadsheet holds the Usage log, student reports and the ChangeLog, so handing a
 * CI credential Editor access to it would grant far more than this job needs. The
 * bridge holds nothing but the already-public timetable, so a leaked key exposes
 * nothing that isn't already on the open web.
 *
 * Apps Script then reads the bridge's published CSV tabs through the ordinary
 * CSV_SOURCES_ path — no special-casing, and it keeps change detection, signatures
 * and the changelog exactly as they work for every other source.
 *
 * ENV
 *   GOOGLE_SERVICE_ACCOUNT_JSON  the service account key, as JSON
 *   BRIDGE_SHEET_ID              the bridge spreadsheet's file id
 */

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

// csv written by extract-timetable.js  ->  tab in the bridge sheet
const MAP = [
  { csv: 'timetable.csv', tab: 'Timetable', required: true },
  { csv: 'guest.csv', tab: 'Guest', required: false },
  { csv: 'feedback.csv', tab: 'Feedback', required: false },
  { csv: 'catalogue.csv', tab: 'Catalogue', required: false },
];

function parseCsv(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function main() {
  const keyRaw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const sheetId = process.env.BRIDGE_SHEET_ID;
  if (!keyRaw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set.');
  if (!sheetId) throw new Error('BRIDGE_SHEET_ID is not set.');

  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(keyRaw),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });

  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const existing = new Set(meta.data.sheets.map(s => s.properties.title));

  for (const item of MAP) {
    const file = path.join(__dirname, item.csv);
    if (!fs.existsSync(file)) {
      if (item.required) throw new Error(item.csv + ' is missing — extraction must have failed.');
      console.log('skip ' + item.csv + ' (not produced)');
      continue;
    }
    const rows = parseCsv(fs.readFileSync(file, 'utf8')).filter(r => r.some(c => c !== ''));
    if (!rows.length) {
      if (item.required) throw new Error(item.csv + ' is empty — refusing to blank ' + item.tab + '.');
      console.log('skip ' + item.tab + ' (no rows)');
      continue;
    }

    if (!existing.has(item.tab)) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: sheetId,
        requestBody: { requests: [{ addSheet: { properties: { title: item.tab } } }] },
      });
      console.log('created tab ' + item.tab);
    }

    // Clear first: a shorter timetable must not leave last run's rows below it,
    // which the parser would read as real classes.
    await sheets.spreadsheets.values.clear({ spreadsheetId: sheetId, range: item.tab });

    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: item.tab + '!A1',
      // RAW, never USER_ENTERED: "14-Sep-2026" must stay the string the institute
      // typed. USER_ENTERED would coerce it to a Sheets date, and the published CSV
      // would then re-render it in the spreadsheet's locale — silently changing the
      // format the parser expects.
      valueInputOption: 'RAW',
      requestBody: { values: rows },
    });
    console.log('wrote ' + item.tab + ': ' + rows.length + ' rows');
  }
  console.log('\nBridge sheet updated.');
}

main().catch(e => { console.error('\n' + (e.message || e) + '\n'); process.exit(1); });
