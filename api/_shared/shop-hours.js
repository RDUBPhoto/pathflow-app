const { TableClient } = require("./table-client");

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIME_ZONE = "America/Chicago";
const WALL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/;

function asHour(value, fallback, maximum) {
  return Number.isInteger(value) && value >= 0 && value <= maximum ? value : fallback;
}

function validShopTimeZone(value) {
  const timeZone = String(value ?? "").trim();
  if (!/^[a-z][\w+./-]*$/i.test(timeZone)) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return null;
  }
}

function normalizeScheduleSettings(raw = {}) {
  const openHour = asHour(raw?.openHour, 7, 23);
  const closeHour = Math.max(openHour + 1, asHour(raw?.closeHour, 16, 24));
  const holidays = Array.isArray(raw?.holidays) ? raw.holidays.map(value => String(value).slice(0, 10)) : [];
  const timeZone = validShopTimeZone(raw?.timeZone) || DEFAULT_TIME_ZONE;
  return { openHour, closeHour, holidays, timeZone, showWeekends: raw?.showWeekends === true };
}

async function readShopHours(connection, tenantId) {
  const settings = TableClient.fromConnectionString(connection, "appsettings");
  try {
    const entity = await settings.getEntity(tenantId, "schedule.settings");
    return normalizeScheduleSettings(JSON.parse(entity.valueJson || "{}"));
  } catch (error) {
    if (error.statusCode !== 404) throw error;
  }
  if (tenantId === "primary-location") return readShopHours(connection, "main");
  return normalizeScheduleSettings();
}

function makeShopCalendar(raw) {
  const settings = normalizeScheduleSettings(raw);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: settings.timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
  const holidays = new Set(settings.holidays);

  function localClock(utcMs) {
    const values = {};
    for (const part of parts.formatToParts(utcMs)) values[part.type] = Number(part.value);
    return Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute, values.second) +
      ((utcMs % 1000 + 1000) % 1000);
  }

  function utcForLocalClock(wallMs) {
    const before = wallMs - (localClock(wallMs - DAY_MS) - (wallMs - DAY_MS));
    const after = wallMs - (localClock(wallMs + DAY_MS) - (wallMs + DAY_MS));
    // Keep the first occurrence in a repeated hour and advance by the gap for a skipped hour.
    return localClock(before) >= wallMs ? before : after;
  }

  function windowForDay(day) {
    const date = new Date(day);
    if (holidays.has(date.toISOString().slice(0, 10))) return null;
    if (!settings.showWeekends && [0, 6].includes(date.getUTCDay())) return null;
    return [
      utcForLocalClock(day + settings.openHour * 60 * 60 * 1000),
      utcForLocalClock(day + settings.closeHour * 60 * 60 * 1000)
    ];
  }

  return {
    parseAppointment(value) {
      const raw = String(value ?? "").trim();
      const wallTime = WALL_TIME.test(raw);
      const timestamp = Date.parse(wallTime ? `${raw}Z` : raw);
      if (!Number.isFinite(timestamp)) return null;
      return new Date(wallTime ? utcForLocalClock(timestamp) : timestamp);
    },
    appointmentMonth(appointment) {
      return new Date(localClock(appointment.getTime())).toISOString().slice(0, 7);
    },
    isOpen(now) {
      const window = windowForDay(Math.floor(localClock(now) / DAY_MS) * DAY_MS);
      return !!window && now >= window[0] && now < window[1];
    },
    elapsed(start, end) {
      const from = new Date(start || "").getTime();
      const to = new Date(end || "").getTime();
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return 0;
      const last = Math.floor(localClock(to) / DAY_MS) * DAY_MS;
      const first = Math.max(Math.floor(localClock(from) / DAY_MS) * DAY_MS, last - 3660 * DAY_MS);
      let total = 0;
      for (let day = first; day <= last; day += DAY_MS) {
        const window = windowForDay(day);
        if (window) total += Math.max(0, Math.min(to, window[1]) - Math.max(from, window[0]));
      }
      return total;
    }
  };
}

function workClock(item, calendar, now = Date.now()) {
  const paused = item.isPaused === true || item.isPaused === "true" || !!item.pausedAt;
  const base = Math.max(0, Number(item.workDurationMs) || 0);
  if (item.completedAt) return { state: "completed", duration: base };
  if (!item.checkedInAt) return { state: "not-started", duration: base };
  if (paused) return { state: "paused", duration: base };
  const resumedAt = item.lastWorkResumedAt || (item.workClockVersion !== 2 ? item.checkedInAt : "");
  if (!resumedAt) return { state: "not-started", duration: base };
  return {
    state: calendar.isOpen(now) ? "working" : "after-hours",
    duration: base + calendar.elapsed(resumedAt, now)
  };
}

module.exports = { makeShopCalendar, normalizeScheduleSettings, readShopHours, validShopTimeZone, workClock };
