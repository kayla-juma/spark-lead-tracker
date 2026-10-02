/**
 * SPARK LEAD TRACKER V3 — backend (Google Sheets + Apps Script)
 *
 * This version adds real per-staff identity: every request must carry a
 * Google ID token from Sign-In With Google, which this script verifies
 * with Google directly, then checks the signed-in email against a
 * "Staff" tab before allowing anything to happen.
 *
 * ONE-TIME SETUP
 * 1. Create a Google Sheet with three tabs: Leads, Activity, Staff.
 *    (Tabs are also auto-created on first use if you skip this, but the
 *    Staff tab needs you to fill it in — see step 4.)
 * 2. Extensions > Apps Script. Paste this whole file in, replacing any
 *    starter code.
 * 3. Set CLIENT_ID below to the OAuth Client ID you create in Google
 *    Cloud Console (Credentials > Create Credentials > OAuth client ID >
 *    Web application). Add your GitHub Pages URL under "Authorized
 *    JavaScript origins". The same Client ID also goes in index.html.
 * 4. In the "Staff" tab, add a header row: email | name | role
 *    Then one row per staff member, role is either "staff" or "admin".
 *    Only admins can delete leads. Only people listed here can sign in
 *    at all — everyone else gets "not authorized" even with a valid
 *    Google login.
 * 5. Deploy > New deployment > Web app.
 *      Execute as: Me
 *      Who has access: Anyone
 *    (Access control happens inside this script via the Staff tab, not
 *    via Apps Script's own access setting — that's what makes it work
 *    for staff on personal Gmail too, not just one Workspace domain.)
 * 6. Copy the deployed URL (ends in /exec) into SYNC_URL near the top of
 *    app.js.
 */

const CLIENT_ID = "252311945181-bvacq392co8b4991p21khegqumos06ak.apps.googleusercontent.com";

const LEADS_SHEET = "Leads";
const ACTIVITY_SHEET = "Activity";
const STAFF_SHEET = "Staff";

const LEAD_HEADERS = ["id","createdAt","updatedAt","name","company","phone","email","business","service","source","status","value","followup","assigned","nextAction","description","notes","customerType"];
const ACTIVITY_HEADERS = ["id","date","leadId","leadName","business","service","text","toStatus","actorEmail","actorName"];
const STAFF_HEADERS = ["email","name","role"];

function getSheet_(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
  } else {
    const lastColumn = Math.max(sheet.getLastColumn(), 1);
    const existing = sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(String);
    const missing = headers.filter(h => !existing.includes(h));
    if (missing.length) sheet.getRange(1, lastColumn + 1, 1, missing.length).setValues([missing]);
  }
  return sheet;
}

function rowsToObjects_(sheet, headers) {
  const data = sheet.getDataRange().getValues();
  return data.slice(1).filter(r => r[0]).map(row => {
    const o = {};
    headers.forEach((h, i) => o[h] = row[i] !== undefined ? row[i] : "");
    return o;
  });
}

// ---------- Auth ----------
function verifyToken_(token) {
  if (!token) return null;
  let res;
  try { res = UrlFetchApp.fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(token), { muteHttpExceptions: true }); }
  catch (err) { return null; }
  if (res.getResponseCode() !== 200) return null;
  let info;
  try { info = JSON.parse(res.getContentText()); } catch (err) { return null; }
  const issuerOk = ["accounts.google.com", "https://accounts.google.com"].includes(info.iss);
  if (info.aud !== CLIENT_ID || !issuerOk || Number(info.exp) * 1000 <= Date.now() || info.email_verified !== "true" || !info.email) return null;
  return { email: info.email.toLowerCase(), name: info.name || info.email };
}

function getStaffRecord_(email) {
  const sheet = getSheet_(STAFF_SHEET, STAFF_HEADERS);
  const staff = rowsToObjects_(sheet, STAFF_HEADERS);
  return staff.find(s => String(s.email).toLowerCase() === email) || null;
}

function authenticate_(token) {
  const identity = verifyToken_(token);
  if (!identity) return { ok: false, error: "invalid_token" };
  const record = getStaffRecord_(identity.email);
  if (!record) return { ok: false, error: "not_authorized", email: identity.email };
  const role = String(record.role || "staff").trim().toLowerCase();
  return { ok: true, email: identity.email, name: record.name || identity.name, role: role === "admin" ? "admin" : "staff" };
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// GET intentionally does not accept credentials. Send authenticated reads to doPost.
function doGet(e) {
  return jsonOut_({ ok: false, error: "post_required" });
}

// ---------- POST: create/update/delete leads, each logged to Activity ----------
function doPost(e) {
  let body;
  try { body = JSON.parse(e && e.postData && e.postData.contents || "{}"); }
  catch (err) { return jsonOut_({ ok: false, error: "invalid_request" }); }
  const auth = authenticate_(body.token);
  if (!auth.ok) return jsonOut_(auth);

  // Read requests use POST so the Google ID token is kept out of the URL.
  if (body.action === "get") {
    const leadsSheet = getSheet_(LEADS_SHEET, LEAD_HEADERS);
    const activitySheet = getSheet_(ACTIVITY_SHEET, ACTIVITY_HEADERS);
    const staffSheet = getSheet_(STAFF_SHEET, STAFF_HEADERS);
    return jsonOut_({
      ok: true,
      you: { email: auth.email, name: auth.name, role: auth.role },
      leads: rowsToObjects_(leadsSheet, LEAD_HEADERS),
      activities: rowsToObjects_(activitySheet, ACTIVITY_HEADERS).sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 100),
      staff: rowsToObjects_(staffSheet, STAFF_HEADERS).map(s => ({ name: s.name }))
    });
  }

  const lock = LockService.getScriptLock();
  try { lock.waitLock(10000); } catch (err) { return jsonOut_({ ok: false, error: "busy" }); }
  try {

  const leadsSheet = getSheet_(LEADS_SHEET, LEAD_HEADERS);
  const activitySheet = getSheet_(ACTIVITY_SHEET, ACTIVITY_HEADERS);

  function logActivity_(leadId, leadName, business, service, text, toStatus) {
    activitySheet.appendRow([Utilities.getUuid(), new Date().toISOString(), leadId, leadName, business || "", service || "", text, toStatus || "", auth.email, auth.name]);
  }

  if (body.action === "upsert") {
    const lead = body.lead;
    const data = leadsSheet.getDataRange().getValues();
    let found = -1;
    for (let i = 1; i < data.length; i++) if (data[i][0] === lead.id) { found = i; break; }
    lead.updatedAt = new Date().toISOString();
    const row = LEAD_HEADERS.map(h => lead[h] !== undefined ? lead[h] : "");
    if (found === -1) {
      lead.createdAt = lead.createdAt || lead.updatedAt;
      leadsSheet.appendRow(LEAD_HEADERS.map(h => lead[h] !== undefined ? lead[h] : ""));
      // Records the lead's starting status too, so "Enquiries" and e.g. a lead
      // created directly as "Qualified" both show up correctly in KPI counts.
      const activityText = lead.customerType === "existing" ? "Opportunity created for existing customer" : "New prospect added";
      logActivity_(lead.id, lead.name, lead.business, lead.service, activityText, lead.status);
    } else {
      const oldStatus = data[found][LEAD_HEADERS.indexOf("status")];
      leadsSheet.getRange(found + 1, 1, 1, row.length).setValues([row]);
      const statusChanged = oldStatus !== lead.status;
      logActivity_(lead.id, lead.name, lead.business, lead.service, body.activityText || (statusChanged ? `Status changed: ${oldStatus} → ${lead.status}` : "Lead updated"), statusChanged ? lead.status : "");
    }
    return jsonOut_({ ok: true });
  }

  if (body.action === "delete") {
    if (auth.role !== "admin") return jsonOut_({ ok: false, error: "forbidden_not_admin" });
    const data = leadsSheet.getDataRange().getValues();
    for (let i = data.length - 1; i >= 1; i--) {
      if (data[i][0] === body.id) {
        logActivity_(body.id, data[i][LEAD_HEADERS.indexOf("name")], data[i][LEAD_HEADERS.indexOf("business")], data[i][LEAD_HEADERS.indexOf("service")], "Lead deleted", "");
        leadsSheet.deleteRow(i + 1);
        break;
      }
    }
    return jsonOut_({ ok: true });
  }

  return jsonOut_({ ok: false, error: "unknown_action" });
  } finally {
    lock.releaseLock();
  }
}
