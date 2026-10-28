// End-to-end check against the in-memory mock. Must end "ERRORS: none".
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
let chromium;
try { ({ chromium } = await import("playwright")); }
catch { ({ chromium } = createRequire("/opt/npm-tools/node_modules/")("playwright")); }

const root = path.resolve("test");
const srv = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  const f = path.join(root, u === "/" ? "index.html" : u);
  if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": f.endsWith(".js") ? "text/javascript" : "text/html" });
  fs.createReadStream(f).pipe(res);
}).listen(5173);

const errors = [];
const check = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) errors.push(m); };
const exe = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/opt/pw-browsers/chromium"].find((p) => fs.existsSync(p));
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
page.on("dialog", (d) => d.accept());
let rampCalls = 0;
await page.route("**/functions/v1/ramp-sync", async (r) => { rampCalls++; await page.evaluate(() => window.__mockRampSync("colson@thevanityportraitstudio.com")); return r.fulfill({ json: { status: "ok", message: "Pulled 4 charges from Ramp since 2026-09-21. 1 new. Claude pre-filled 1: 1 green, 0 orange, 0 red." } }); });
await page.route("**/functions/v1/sf-sync", (r) => r.fulfill({ json: { status: "not_connected", message: "Salesforce is not connected yet." } }));
const last = () => page.evaluate(() => window.__overrides.at(-1));
const row = (t) => page.locator("table.xtab tr.xr", { hasText: t });
const evOpts = async (r) => { await r.locator(".ev-in").click(); const o = (await r.locator(".ev-pop .ev-opt").allTextContents()).filter((t) => !t.startsWith("Overhead")); return o; };
const closeEv = async (r) => { await r.locator(".ev-in").press("Escape"); };

await page.goto("http://localhost:5173/");
await page.waitForSelector("h2:has-text('Expenses')");
check(await page.locator(".top .seg button.on").textContent().then((t) => t.startsWith("Expenses")), "Expenses is the landing tab");
check(await page.locator(".seg.light button.on").textContent().then((t) => t.startsWith("Not added to an event")), "Not added is the default bucket");
const notAdded = await page.locator("table.xtab tr.xr .merch").allTextContents();
check(JSON.stringify(notAdded) === JSON.stringify(["Drip Drop Coffee", "Hilton Santa Fe", "Doordash"]), "Not added = Gusto guess, Japhy hotel, Doordash, newest first: " + notAdded.join(", "));
await page.screenshot({ path: "test/shot-expenses.png", fullPage: true });

// confidence colours
check(await row("Drip Drop Coffee").evaluate((e) => e.classList.contains("conf-high")) && await row("Drip Drop Coffee").locator(".cf.high").textContent() === "Strong match", "green row for a strong match");
check(await row("Drip Drop Coffee").locator(".cf-why").count() === 0, "green row needs no explanation line");
check(await row("Hilton Santa Fe").evaluate((e) => e.classList.contains("conf-low")) && await row("Hilton Santa Fe").locator(".cf-why").textContent().then((t) => t.includes("not who the rooms")), "red row shows why");
check(await row("Doordash").evaluate((e) => e.classList.contains("conf-low")), "held with no stored confidence falls back to red");
const stripe = await row("Drip Drop Coffee").locator("td").first().evaluate((e) => getComputedStyle(e).boxShadow);
check(stripe.includes("21, 128, 61") && stripe.includes("6px"), "bold green stripe on the row edge (" + stripe + ")");
check(await page.locator(".cf-chip.high .n").textContent() === "1" && await page.locator(".cf-chip.low .n").textContent() === "2", "legend counts 1 green / 2 red");
await page.locator(".cf-chip.low").click();
check(JSON.stringify(await page.locator("table.xtab tr.xr .merch").allTextContents()) === JSON.stringify(["Hilton Santa Fe", "Doordash"]), "Verify chip filters to red rows");
await page.locator(".cf-chip.low").click();
check(await page.locator("table.xtab tr.xr").count() === 3, "clicking again clears the filter");

// Gusto best guess: pre-filled, add in one click
const gusto = row("Drip Drop Coffee");
check(await gusto.locator(".src", { hasText: "Gusto" }).count() === 1, "Gusto source shown");
check(await gusto.locator(".ev-in").inputValue().then((v) => v.includes("Roots")), "guessed event pre-filled in the event picker");
check(await gusto.locator(".sp-btn").textContent().then((t) => t.includes("Kiki Dickie")), "guessed staff pre-ticked");
// half-finished picks on another row must survive this save
await row("Doordash").locator(".cat-c select").selectOption("hotels");
await gusto.locator("button", { hasText: "Add to event" }).click();
await page.waitForSelector(".toast >> text=Added to the event.");
check(await row("Doordash").locator(".cat-c select").inputValue() === "hotels", "picks on another row survive a save elsewhere");
await row("Doordash").locator(".cat-c select").selectOption("per_diem");
let o = await last();
check(o.action === "reassign" && o.staffing_sf_id === "S2" && o.sf_category === "per_diem", "Add sends reassign to Kiki / Per Diem");
check(await row("Drip Drop Coffee").count() === 0, "added charge leaves Not added");

// Japhy hotel: event known, no staff -> button disabled, Japhy's card chip
const hil = row("Hilton Santa Fe");
check(await hil.locator(".chip.jc").count() === 1, "Japhy's card chip");
const hilOpts = await evOpts(hil); await closeEv(hil);
check(hilOpts.length === 2 && !hilOpts.some((t) => t.includes("Old Spring")) && !hilOpts.some((t) => t.includes("Lost")), "Japhy's card: upcoming or last-30-day events only (got " + hilOpts.join(" | ") + ")");
check(await hil.locator("button", { hasText: "Tick staff to add" }).isDisabled(), "cannot add without staff");
await hil.locator(".sp-btn").click();
await hil.locator(".sp-opt", { hasText: "Billy Cole" }).locator("input").check();
await hil.locator(".sp-opt", { hasText: "Stephanie Walker" }).locator("input").check();
check(await hil.locator(".sp-pop").textContent().then((t) => t.includes("Split evenly 2 ways")), "split hint");
await hil.locator(".sp-pop button", { hasText: "Done" }).click();
check(await hil.locator(".cat-c select").inputValue() === "hotels", "category guessed from Ramp (hotels)");
await hil.locator("button", { hasText: "Add to event" }).click();
await page.waitForSelector(".toast >> text=Added to the event.");
o = await last();
check(o.action === "split" && o.split_staffing_ids.join() === "S1,S3" && o.sf_category === "hotels", "split across Billy + Stephanie");

// Doordash: no event. choose event -> payer preticked (Billy on crew)
const dd = row("Doordash");
check(await dd.locator("button", { hasText: "Choose an event" }).isDisabled(), "no event -> disabled");
const ddOpts = await evOpts(dd);
check(ddOpts.length === 1 && ddOpts[0].includes("Roots"), "other card: only events the card holder is staffed on within 30 days (got " + ddOpts.join(" | ") + ")");
await dd.locator(".ev-pop .ev-more").click();
await page.waitForTimeout(150);
const ddMore = await dd.locator(".ev-pop .ev-opt").allTextContents();
check(ddMore.some((t) => t.includes("Old Spring Gala")) && ddMore.some((t) => t.includes("Edward")), "Show more events relaxes to every event");
check(!ddMore.some((t) => t.includes("Lost Gala")), "Closed Lost never shown, even with Show more");
check(await dd.locator(".ev-pop .ev-g").first().textContent() === "Within 3 weeks of the charge", "relaxed list groups near-date events first");
// type to narrow in real time
await dd.locator(".ev-in").fill("edward");
const typed = await dd.locator(".ev-pop .ev-opt").allTextContents();
check(typed.length === 1 && typed[0].includes("Edward"), "typing 'edward' narrows the list to one event (got " + typed.join(" | ") + ")");
await dd.locator(".ev-in").fill("oakland");
check((await dd.locator(".ev-pop .ev-opt").allTextContents()).some((t) => t.includes("Old Spring")), "search also matches the city");
await dd.locator(".ev-in").fill("roots");
await dd.locator(".ev-in").press("Enter");
check(await dd.locator(".ev-in").inputValue().then((v) => v.includes("Roots")), "Enter picks the highlighted event");
check(await dd.locator(".sp-btn").textContent().then((t) => t.includes("Billy Cole")), "payer pre-ticked when on the crew");
check(!(await dd.evaluate((e) => e.className.includes("conf-"))), "colour clears once someone changes the dropdowns");
await dd.locator(".ev-in").click();
await dd.locator(".ev-in").fill("overh");
await dd.locator(".ev-pop .ev-opt", { hasText: "Overhead" }).click();
await dd.locator("button", { hasText: "Mark overhead" }).click();
await page.waitForSelector(".toast >> text=Marked as overhead.");
check((await last()).action === "mark_overhead", "overhead from the event dropdown");
await page.waitForSelector("text=Every charge has been added to an event or marked overhead.");
check(true, "Not added empties");

// buckets
await page.locator(".seg.light button", { hasText: "Overhead" }).click();
check(await row("Doordash").count() === 1, "Doordash in Overhead");
await page.locator(".seg.light button", { hasText: "Added to event" }).click();
check(await page.locator("table.xtab tr.xr[class*='conf-']").count() === 0, "no colour on charges a person already added");
check(await row("Southwest").locator(".badge", { hasText: "In Salesforce" }).count() === 1, "added Southwest shows In Salesforce");
// change category on an added row -> Save change
const ub = row("Uber");
await ub.locator(".cat-c select").selectOption("other");
await ub.locator("button", { hasText: "Save change" }).click();
await page.waitForSelector(".toast >> text=Saved.");
check((await last()).sf_category === "other", "Save change on an added row");

// event page: remove from event -> back to Not added with guess kept
await row("Southwest").locator("a", { hasText: "Open event" }).click();
await page.waitForSelector("table.xgrid");
await page.screenshot({ path: "test/shot-event.png", fullPage: true });
check(await page.locator("tbody.card-b").count() === 0, "no Japhy's Card block on the event page any more");
await page.locator("tr.ln", { hasText: "Southwest" }).locator("button", { hasText: "Remove from event" }).click();
await page.waitForSelector(".toast >> text=Removed.");
check((await last()).action === "remove", "Remove from event sends remove");
check(await page.locator("tr.ln", { hasText: "Southwest" }).count() === 0, "flight gone from the event grid");
check(await page.locator(".sum.held .v").textContent() === "$655.60", "waiting-to-be-added tile shows it");
await page.locator(".sum.held").click();
await page.waitForSelector("text=Showing charges for");
const sw = row("Southwest");
check(await sw.locator(".ev-in").inputValue().then((v) => v.includes("Roots")) && await sw.locator(".sp-btn").textContent().then((t) => t.includes("Billy")), "removed charge back with its old placement as the guess");
check(await sw.locator("button", { hasText: "Add to event" }).count() === 1, "and can be re-added");
check(await sw.evaluate((e) => e.classList.contains("conf-medium")) && await sw.locator(".cf-why").textContent().then((t) => t.includes("carried over")), "removed charge comes back orange");

// Sync from Ramp
await page.locator(".top .seg button", { hasText: "Expenses" }).click();
await page.waitForSelector(".ramp-sync");
check(await page.locator(".ramp-sync .xs").textContent().then((t) => t.startsWith("Last pulled")), "shows when Ramp was last pulled");
await page.locator(".seg.light button", { hasText: "Not added" }).click();
await page.locator(".ramp-sync button").click();
await page.waitForSelector(".toast >> text=Claude pre-filled 1");
check(rampCalls === 1, "Sync from Ramp calls the ramp-sync function once");
const bb = row("Blue Bottle");
check(await bb.count() === 1 && await bb.evaluate((e) => e.classList.contains("conf-high")), "new charge appears in Not added with Claude's green guess");
check(await page.locator(".ramp-sync .xs").textContent().then((t) => t.includes("by colson")), "last-pulled line shows who pressed it");

// Wages: Ignore removes a "Timesheet not entered properly" line, Undo puts it back
await page.locator(".top .seg button", { hasText: "Wages" }).click();
await page.waitForSelector("h3:has-text('Timesheet not entered properly')");
const tsCard = page.locator(".sec-h:has(h3:has-text('Timesheet not entered properly')) + .card");
const tsRows = () => tsCard.locator("tbody tr");
check(await tsRows().count() === 2, "two timesheet lines to fix");
const kikiRow = tsRows().filter({ hasText: "Kiki Dickie" });
check(await kikiRow.textContent().then((t) => t.includes("6.0 h · Photographer In-Training") && t.includes("Admin/Commuting")), "record-level line lists that day's Gusto entries with their jobs");
check(await tsRows().filter({ hasText: "Billy Cole" }).locator("td").nth(3).textContent().then((t) => t.trim() === "Admin/Commuting"), "a $25/hr entry with no stored title shows Admin/Commuting");
await tsRows().filter({ hasText: "Billy Cole" }).locator("button", { hasText: "Ignore" }).click();
await page.waitForFunction(() => window.__ignores.length === 1);
await page.waitForTimeout(300);
const ig = await page.evaluate(() => window.__ignores[0]);
check(ig.issue_key === "wrong_rate:W1" && ig.ignored === true && ig.decided_by === "colson@thevanityportraitstudio.com" && ig.wage_shift_id === "W1" && ig.staffing_sf_id === "S1", "Ignore records the line, who, and the shift");
check(await tsRows().count() === 1 && await tsRows().filter({ hasText: "Billy Cole" }).count() === 0, "ignored line leaves the list");
await page.locator(".ts-undo button", { hasText: "Undo" }).click();
await page.waitForFunction(() => window.__ignores.length === 2);
await page.waitForTimeout(300);
check(await page.evaluate(() => window.__ignores[1].ignored === false), "Undo writes ignored=false");
check(await tsRows().count() === 2, "Undo puts the line back");
const sfCard = page.locator(".sec-h:has(h3:has-text('Salesforce fixes for Japhy')) + .card");
check(await tsRows().filter({ hasText: "Stephanie Walker" }).count() === 0, "travel-compensation lines are not in Timesheet not entered properly");
const sfRow = sfCard.locator("tbody tr");
check(await sfRow.count() === 1 && await sfRow.textContent().then((t) => t.includes("Stephanie Walker") && t.includes("1.0 h Admin/Commuting") && t.includes("8.0 h Print Manager / Editor")), "Salesforce fixes for Japhy lists the event with the crew's Gusto entries by job");
await sfRow.locator("input[type=checkbox]").check();
await sfCard.locator("button", { hasText: "Draft email to Japhy" }).click();
await page.waitForFunction(() => window.__emailReqs.length === 1);
check(await page.evaluate(() => window.__emailReqs[0].audience === "admin" && window.__emailReqs[0].issue_key === "travel_comp_undetermined:S3"), "Draft email to Japhy queues the admin request");
await sfRow.locator("button", { hasText: "Ignore" }).click();
await page.waitForFunction(() => window.__ignores.length === 3);
await page.waitForTimeout(300);
check(await sfCard.locator("tbody tr").count() === 0, "Ignore removes the Salesforce fix row");
await page.locator(".top .seg button", { hasText: "Expenses" }).click();
await page.waitForSelector("h2:has-text('Expenses')");

// phone width
await page.setViewportSize({ width: 390, height: 844 });
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
check(!overflow, "no page-level horizontal scroll at phone width");
await page.screenshot({ path: "test/shot-phone.png" });

// a TVPS member who isn't an admin can still pull and categorize
const p2 = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
p2.on("pageerror", (e) => errors.push("pageerror(member): " + e.message));
await p2.route("**/functions/v1/ramp-sync", (r) => r.fulfill({ json: { status: "ok", message: "Nothing new." } }));
await p2.goto("http://localhost:5173/?as=member");
await p2.waitForSelector("h2:has-text('Expenses')");
check(await p2.locator(".ramp-sync button").count() === 1, "member sees Sync from Ramp");
check(await p2.locator("table.xtab button", { hasText: "Add to event" }).count() >= 1, "member can Add to event");
check(await p2.locator(".top .sync-btn").count() === 0, "member does not get Salesforce Sync all");
await p2.locator(".top .seg button", { hasText: "Wages" }).click();
await p2.waitForSelector("h3:has-text('Timesheet not entered properly')");
check(await p2.locator("button", { hasText: "Ignore" }).count() === 0, "member does not get Ignore (editors only)");
await p2.close();

await browser.close(); srv.close();
console.log("\nERRORS:", errors.length ? "\n" + errors.join("\n") : "none");
process.exit(errors.length ? 1 : 0);
