const test = require("node:test");
const assert = require("node:assert/strict");
const { TableClient } = require("../_shared/table-client");
const { makeShopCalendar, readShopHours, workClock } = require("../_shared/shop-hours");

test("shop time skips the weekend and a holiday across a daylight saving boundary", () => {
  const calendar = makeShopCalendar({ timeZone: "America/Chicago", openHour: 7, closeHour: 16,
    holidays: ["2026-11-02"] });
  const fridayAfternoon = "2026-10-30T20:00:00Z";
  const tuesdayMorning = "2026-11-03T14:00:00Z";
  assert.equal(calendar.elapsed(fridayAfternoon, tuesdayMorning), 2 * 60 * 60 * 1000);
  assert.equal(calendar.isOpen(Date.parse("2026-11-02T14:00:00Z")), false);
  assert.equal(calendar.isOpen(Date.parse(tuesdayMorning)), true);
});

test("check-in, manual hold, and after-hours time remain distinct", () => {
  const calendar = makeShopCalendar({ timeZone: "America/Chicago" });
  const checkedInAt = "2026-11-10T14:00:00Z";
  const now = Date.parse("2026-11-11T01:00:00Z");
  assert.deepEqual(workClock({ checkedInAt, workClockVersion: 2 }, calendar, now), { state: "not-started", duration: 0 });
  assert.deepEqual(workClock({ checkedInAt, lastWorkResumedAt: checkedInAt, workClockVersion: 2 }, calendar, now),
    { state: "after-hours", duration: 8 * 60 * 60 * 1000 });
  assert.deepEqual(workClock({ checkedInAt, isPaused: true, workDurationMs: 2500 }, calendar, now),
    { state: "paused", duration: 2500 });
});

test("changing the shop zone changes open hours and the running job clock", () => {
  const central = makeShopCalendar({ timeZone: "America/Chicago" });
  const pacific = makeShopCalendar({ timeZone: "America/Los_Angeles" });
  const checkedInAt = "2026-11-10T14:00:00Z";
  const now = Date.parse("2026-11-10T14:30:00Z");
  const item = { checkedInAt, lastWorkResumedAt: checkedInAt, workClockVersion: 2 };
  assert.deepEqual(workClock(item, central, now), { state: "working", duration: 30 * 60 * 1000 });
  assert.deepEqual(workClock(item, pacific, now), { state: "after-hours", duration: 0 });
});

test("appointment forecasts use the shop's date and handle DST transitions", () => {
  const calendar = makeShopCalendar({ timeZone: "America/Los_Angeles" });
  const appointment = calendar.parseAppointment("2026-10-31T18:30:00");
  assert.equal(appointment.toISOString(), "2026-11-01T01:30:00.000Z");
  assert.equal(calendar.appointmentMonth(appointment), "2026-10");
  assert.equal(calendar.parseAppointment("2026-11-01T01:30:00").toISOString(), "2026-11-01T08:30:00.000Z");
  const lordHowe = makeShopCalendar({ timeZone: "Australia/Lord_Howe" });
  assert.equal(lordHowe.parseAppointment("2026-10-04T02:15:00").toISOString(), "2026-10-03T15:45:00.000Z");
});

test("saved schedule settings feed the job clock and reject invalid zones", async t => {
  const previousStorage = process.env.STORAGE_CONNECTION_STRING;
  process.env.STORAGE_CONNECTION_STRING = "UseDevelopmentStorage=true";
  t.after(() => {
    if (previousStorage === undefined) delete process.env.STORAGE_CONNECTION_STRING;
    else process.env.STORAGE_CONNECTION_STRING = previousStorage;
  });
  const rows = new Map([
    ["main/schedule.settings", { valueJson: JSON.stringify({ timeZone: "US/Central" }) }]
  ]);
  t.mock.method(TableClient, "fromConnectionString", () => ({
    async createTable() {},
    async getEntity(partition, key) {
      const row = rows.get(`${partition}/${key}`);
      if (!row) throw Object.assign(new Error("Setting not found"), { statusCode: 404 });
      return row;
    },
    async upsertEntity(row) { rows.set(`${row.partitionKey}/${row.rowKey}`, row); }
  }));
  t.mock.method(require("../_shared/auth"), "requirePrincipal", async () => ({ userId: "schedule-qa" }));
  const handler = require("../settings");
  const key = "schedule.settings";
  const headers = { "x-tenant-id": "primary-location" };
  async function request(method, body) {
    const context = { log: { error(error) { throw error; } } };
    await handler(context, { method, body, headers, query: { key } });
    return context.res;
  }

  assert.equal((await request("GET")).body.value.timeZone, "US/Central");
  const value = { timeZone: "America/Los_Angeles", openHour: 8, closeHour: 17 };
  assert.equal((await request("POST", { key, value })).status, 200);
  assert.equal((await request("POST", { key, value: { timeZone: "Mars/Olympus" } })).status, 400);
  assert.deepEqual((await request("GET")).body.value, value);
  assert.equal((await readShopHours("UseDevelopmentStorage=true", "primary-location")).timeZone, value.timeZone);
  assert.equal(JSON.parse(rows.get("main/schedule.settings").valueJson).timeZone, "US/Central");
});
