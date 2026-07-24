function getTimeParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function formatDateTime(date, timeZone) {
  const parts = getTimeParts(date, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}-${pad(parts.minute)}-${pad(parts.second)}`;
}

function parseDailyCron(cron) {
  const parts = String(cron || "").trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Unsupported cron expression: ${cron}`);
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  if (dayOfMonth !== "*" || month !== "*" || dayOfWeek !== "*") {
    throw new Error(`Only daily cron expressions are supported: ${cron}`);
  }

  return {
    minute: Number(minute),
    hour: Number(hour),
  };
}

function cronMatchesDate(cron, timeZone, date) {
  const schedule = parseDailyCron(cron);
  const parts = getTimeParts(date, timeZone);
  return schedule.hour === parts.hour && schedule.minute === parts.minute;
}

function getNextRunDate(crons, timeZone, now = new Date()) {
  const cursor = new Date(now.getTime());
  cursor.setSeconds(0, 0);

  for (let i = 1; i <= 60 * 48; i += 1) {
    cursor.setMinutes(cursor.getMinutes() + 1);
    if (crons.some((cron) => cronMatchesDate(cron, timeZone, cursor))) {
      return new Date(cursor.getTime());
    }
  }

  return null;
}

module.exports = {
  cronMatchesDate,
  formatDateTime,
  getNextRunDate,
  getTimeParts,
};
