// js/dates.js
var WEEKDAYS = ["\uC77C", "\uC6D4", "\uD654", "\uC218", "\uBAA9", "\uAE08", "\uD1A0"];
var pad = (n) => String(n).padStart(2, "0");
function toISODate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function fromISODate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function today(now = /* @__PURE__ */ new Date()) {
  return toISODate(now);
}
function addDays(iso, n) {
  const d = fromISODate(iso);
  d.setDate(d.getDate() + n);
  return toISODate(d);
}
function diffDays(a, b) {
  return Math.round((fromISODate(a) - fromISODate(b)) / 864e5);
}
function formatLong(iso) {
  const d = fromISODate(iso);
  return `${d.getMonth() + 1}\uC6D4 ${d.getDate()}\uC77C ${WEEKDAYS[d.getDay()]}\uC694\uC77C`;
}
function formatShort(iso) {
  const d = fromISODate(iso);
  return `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS[d.getDay()]})`;
}
function formatRelative(iso, todayIso = today()) {
  const diff = diffDays(iso, todayIso);
  if (diff === 0) return "\uC624\uB298";
  if (diff === 1) return "\uB0B4\uC77C";
  if (diff === 2) return "\uBAA8\uB808";
  if (diff === -1) return "\uC5B4\uC81C";
  return formatShort(iso);
}
function formatTime(hhmm2) {
  if (!hhmm2) return "";
  const [h, m] = hhmm2.split(":").map(Number);
  const ampm = h < 12 ? "\uC624\uC804" : "\uC624\uD6C4";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${ampm} ${h12}\uC2DC` : `${ampm} ${h12}:${pad(m)}`;
}

// js/store.js
var PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
var EPOCH = "1970-01-01T00:00:00.000Z";
var COLLECTIONS = ["todos", "events", "memos"];
var REPEATS = ["daily", "weekly", "monthly", "yearly"];
var KNOWN_KEYS = /* @__PURE__ */ new Set(["format", "version", "settings", "briefingSeen", "extras", ...COLLECTIONS, "deleted", "devices", "vapid"]);
var BRIEFING_TAG = "\uBE0C\uB9AC\uD551";
function defaultState() {
  return {
    version: 1,
    settings: { name: "Daniel", theme: "auto" },
    todos: [],
    events: [],
    memos: [],
    deleted: {},
    devices: {},
    vapid: null,
    extras: {},
    // 더 새 버전의 앱이 추가한 데이터(이 버전은 쓰지 않지만 지우지 않는다)
    briefingSeen: null
  };
}
var state = defaultState();
var isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
var str = (v, d = "") => typeof v === "string" ? v : d;
var stamp = (v, d = EPOCH) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(v) ? v : d;
function normalizeDevices(v) {
  const out = {};
  if (!isObj(v)) return out;
  Object.entries(v).forEach(([id, d]) => {
    if (!isObj(d) || !/^[\w-]{4,64}$/.test(id)) return;
    const p = d.push;
    const push = isObj(p) && /^https:\/\//.test(str(p.endpoint)) && isObj(p.keys) && str(p.keys.p256dh) && str(p.keys.auth) ? { endpoint: p.endpoint, keys: { p256dh: p.keys.p256dh, auth: p.keys.auth } } : null;
    out[id] = { label: str(d.label, "\uAE30\uAE30").slice(0, 40), push, vapidKey: str(d.vapidKey) || null, updatedAt: stamp(d.updatedAt) };
  });
  return out;
}
function normalizeVapid(v) {
  if (!isObj(v)) return null;
  const pub = str(v.publicKey);
  const priv = str(v.privateKey);
  if (!/^[\w-]{80,100}$/.test(pub) || !/^[\w-]{40,50}$/.test(priv)) return null;
  return { publicKey: pub, privateKey: priv, createdAt: stamp(v.createdAt) };
}
function normalizeDeleted(v) {
  const out = {};
  if (!isObj(v)) return out;
  Object.entries(v).forEach(([id, at]) => {
    if (id && typeof at === "string") out[id] = stamp(at);
  });
  return out;
}
var keepExtra = (x) => Object.fromEntries(Object.entries(x).filter(([, v]) => v !== void 0));
function extrasOf(data) {
  const out = isObj(data.extras) ? { ...data.extras } : {};
  Object.keys(data).forEach((k) => {
    if (!KNOWN_KEYS.has(k)) out[k] = data[k];
  });
  return out;
}
function normalize(data) {
  const base = defaultState();
  if (!isObj(data)) return base;
  const arr = (v) => Array.isArray(v) ? v.filter(isObj) : [];
  const isoOrNull = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
  const timeOrNull = (v) => typeof v === "string" && /^\d{2}:\d{2}$/.test(v) ? v : null;
  const tags = (v) => Array.isArray(v) ? v.filter((t) => typeof t === "string" && t) : [];
  const remindOrNull = (v) => Number.isInteger(v) && v >= 0 && v <= 10080 ? v : null;
  return {
    version: 1,
    settings: { ...base.settings, ...isObj(data.settings) ? {
      name: str(data.settings.name, "Daniel") || "Daniel",
      theme: ["auto", "light", "dark"].includes(data.settings.theme) ? data.settings.theme : "auto"
    } : {} },
    todos: arr(data.todos).map((t) => {
      const createdAt = stamp(t.createdAt, stamp(t.updatedAt));
      return {
        ...keepExtra(t),
        id: str(t.id) || uid(),
        title: str(t.title, "(\uC81C\uBAA9 \uC5C6\uC74C)"),
        due: isoOrNull(t.due),
        time: timeOrNull(t.time),
        priority: t.priority in PRIORITY_RANK ? t.priority : "medium",
        tags: tags(t.tags),
        notes: str(t.notes),
        repeat: REPEATS.includes(t.repeat) ? t.repeat : null,
        done: !!t.done,
        doneAt: str(t.doneAt) || null,
        createdAt,
        updatedAt: stamp(t.updatedAt, createdAt),
        originalDue: isoOrNull(t.originalDue),
        postponed: Number.isInteger(t.postponed) ? t.postponed : 0,
        remind: remindOrNull(t.remind)
      };
    }),
    events: arr(data.events).filter((e) => isoOrNull(e.date)).map((e) => {
      const createdAt = stamp(e.createdAt, stamp(e.updatedAt));
      return {
        ...keepExtra(e),
        id: str(e.id) || uid(),
        title: str(e.title, "(\uC81C\uBAA9 \uC5C6\uC74C)"),
        date: e.date,
        time: timeOrNull(e.time),
        endTime: timeOrNull(e.endTime),
        // 여러 날 일정의 마지막 날(하루짜리면 null)
        endDate: isoOrNull(e.endDate) && e.endDate > e.date ? e.endDate : null,
        remind: remindOrNull(e.remind),
        // 반복: 매일·매주·매월·매년, 반복 끝나는 날(없으면 계속), 건너뛴 날짜들
        repeat: REPEATS.includes(e.repeat) ? e.repeat : null,
        repeatUntil: REPEATS.includes(e.repeat) && isoOrNull(e.repeatUntil) && e.repeatUntil >= e.date ? e.repeatUntil : null,
        exdates: REPEATS.includes(e.repeat) && Array.isArray(e.exdates) ? [...new Set(e.exdates.filter((d) => isoOrNull(d)))].sort() : [],
        location: str(e.location),
        notes: str(e.notes),
        createdAt,
        updatedAt: stamp(e.updatedAt, createdAt)
      };
    }),
    memos: arr(data.memos).map((m) => {
      const createdAt = stamp(m.createdAt, stamp(m.updatedAt));
      return {
        ...keepExtra(m),
        id: str(m.id) || uid(),
        title: str(m.title),
        body: str(m.body),
        tags: tags(m.tags),
        pinned: !!m.pinned,
        createdAt,
        updatedAt: stamp(m.updatedAt, createdAt)
      };
    }),
    deleted: normalizeDeleted(data.deleted),
    devices: normalizeDevices(data.devices),
    vapid: normalizeVapid(data.vapid),
    extras: extrasOf(data),
    briefingSeen: isoOrNull(data.briefingSeen)
  };
}
function uid() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
function compareTodos(a, b) {
  if (a.done !== b.done) return a.done ? 1 : -1;
  if (a.done) return (b.doneAt || "").localeCompare(a.doneAt || "");
  if ((a.due || "9999") !== (b.due || "9999")) return (a.due || "9999").localeCompare(b.due || "9999");
  if (PRIORITY_RANK[a.priority] !== PRIORITY_RANK[b.priority]) return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if ((a.time || "99") !== (b.time || "99")) return (a.time || "99").localeCompare(b.time || "99");
  return a.createdAt.localeCompare(b.createdAt);
}
function overdueTodos(s, todayIso) {
  return s.todos.filter((t) => !t.done && t.due && t.due < todayIso).sort(compareTodos);
}
function todosDueOn(s, iso) {
  return s.todos.filter((t) => !t.done && t.due === iso).sort(compareTodos);
}
function todosDoneOn(s, iso) {
  return s.todos.filter((t) => t.done && t.doneAt && toISODate(new Date(t.doneAt)) === iso);
}
var isMultiDay = (e) => !!e.endDate && e.endDate > e.date;
function sameDayMonthsLater(iso, n) {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7)) - 1 + n;
  const d = Number(iso.slice(8, 10));
  const ty = y + Math.floor(m / 12);
  const tm = (m % 12 + 12) % 12;
  if (d > new Date(ty, tm + 1, 0).getDate()) return null;
  return toISODate(new Date(ty, tm, d));
}
function nthStart(e, n) {
  if (e.repeat === "daily") return addDays(e.date, n);
  if (e.repeat === "weekly") return addDays(e.date, 7 * n);
  return sameDayMonthsLater(e.date, (e.repeat === "yearly" ? 12 : 1) * n);
}
function occurrences(e, from, to) {
  const span = isMultiDay(e) ? diffDays(e.endDate, e.date) : 0;
  if (!e.repeat) {
    const end = addDays(e.date, span);
    return e.date <= to && end >= from ? [{ date: e.date, endDate: end }] : [];
  }
  const out = [];
  const exdates = new Set(e.exdates || []);
  const earliest = addDays(from, -span);
  let n = 0;
  if (earliest > e.date) {
    const gap = diffDays(earliest, e.date);
    const months = (Number(earliest.slice(0, 4)) - Number(e.date.slice(0, 4))) * 12 + Number(earliest.slice(5, 7)) - Number(e.date.slice(5, 7));
    n = Math.max(0, {
      daily: gap,
      weekly: Math.floor(gap / 7),
      monthly: months - 1,
      yearly: Math.floor(months / 12) - 1
    }[e.repeat]);
  }
  for (let guard = 0; guard < 2e3; guard += 1, n += 1) {
    const start = nthStart(e, n);
    if (start === null) continue;
    if (start > to || e.repeatUntil && start > e.repeatUntil) break;
    const end = addDays(start, span);
    if (end >= from && !exdates.has(start)) out.push({ date: start, endDate: end });
  }
  return out;
}
function compareEvents(a, b) {
  if (a.date !== b.date) return a.date.localeCompare(b.date);
  return (a.time || "").localeCompare(b.time || "");
}
function eventsBetween(s, from, to) {
  return s.events.flatMap((e) => occurrences(e, from, to).map((o) => ({ ...e, date: o.date, endDate: o.endDate, seriesDate: e.date, allDay: !e.time }))).sort(compareEvents);
}
function eventsOn(s, iso) {
  return eventsBetween(s, iso, iso).sort((a, b) => (a.time || "").localeCompare(b.time || ""));
}

// js/reminders.js
var ALL_DAY_BASE = "09:00";
var dateOf = (item, kind) => kind === "todo" ? item.due : item.date;
function baseTime(item, kind) {
  const date = dateOf(item, kind);
  if (!date) return null;
  const [h, mi] = (item.time || ALL_DAY_BASE).split(":").map(Number);
  const d = fromISODate(date);
  d.setHours(h, mi, 0, 0);
  return d;
}
function fireAt(item, kind) {
  if (item.remind == null || kind === "todo" && item.done) return null;
  const base = baseTime(item, kind);
  return base ? new Date(base.getTime() - item.remind * 6e4) : null;
}
function relative(item, kind, at) {
  const date = dateOf(item, kind);
  const dayGap = diffDays(date, toISODate(at));
  const day = dayGap === 0 ? "\uC624\uB298" : dayGap === 1 ? "\uB0B4\uC77C" : formatShort(date);
  if (!item.time) return day;
  if (dayGap > 0) return `${day} ${formatTime(item.time)}`;
  const mins = item.remind;
  if (mins === 0) return `\uC9C0\uAE08(${formatTime(item.time)})`;
  const ahead = mins % 60 === 0 ? `${mins / 60}\uC2DC\uAC04 \uD6C4` : `${mins}\uBD84 \uD6C4`;
  return `${ahead}(${formatTime(item.time)})`;
}
function message(item, kind, at) {
  const when = relative(item, kind, at);
  if (kind === "event") {
    const multi = item.endDate && item.endDate > item.date ? ` ~ ${formatShort(item.endDate)}` : "";
    const start = item.time ? `${when} \uC2DC\uC791` : `${when} \uC885\uC77C \uC77C\uC815${multi}`;
    return {
      title: `\uC77C\uC815 \xB7 ${item.title}`,
      body: [start, item.location].filter(Boolean).join(" \xB7 ")
    };
  }
  return {
    title: `\uD560 \uC77C \xB7 ${item.title}`,
    body: `${when} \uB9C8\uAC10${item.priority === "high" ? " \xB7 \uC911\uC694" : ""}`
  };
}
function dueReminders(state2, from, to) {
  const out = [];
  const add = (item, kind) => {
    const at = fireAt(item, kind);
    if (!at || at <= from || at > to) return;
    out.push({
      // 기기·발송기의 시계(시간대)와 상관없이 같은 알람이면 같은 값 → 알림이 겹치지 않고 하나로 합쳐진다
      key: `${kind}:${item.id}:${dateOf(item, kind)}:${item.time || "allday"}:${item.remind}`,
      kind,
      id: item.id,
      at,
      url: kind === "event" ? "./#calendar" : "./#todos",
      ...message(item, kind, at)
    });
  };
  state2.todos.forEach((t) => add(t, "todo"));
  state2.events.forEach((e) => {
    if (e.remind == null) return;
    const lead = Math.ceil(e.remind / 1440) + 1;
    const toDay = new Date(to.getTime() + lead * 864e5);
    occurrences(e, toISODate(from), toISODate(toDay)).forEach((o) => add({ ...e, date: o.date, endDate: o.endDate }, "event"));
  });
  return out.sort((a, b) => a.at - b.at || a.title.localeCompare(b.title));
}
var LATE_WINDOW = 15 * 6e4;

// js/briefing.js
var PRIORITY_RANK2 = { high: 0, medium: 1, low: 2 };
function eventLine(e, day = e.date) {
  const multi = e.endDate && e.endDate > e.date;
  const when = !e.time || multi && day !== e.date ? "\uC885\uC77C" : formatTime(e.time);
  const span = multi ? ` (${formatShort(e.date)}~${formatShort(e.endDate)})` : "";
  return `${when} ${e.title}${span}${e.location ? ` \xB7 ${e.location}` : ""}`;
}
function memoLine(m) {
  const title = m.title || "(\uC81C\uBAA9 \uC5C6\uC74C)";
  const first = (m.body || "").split("\n").map((l) => l.trim()).filter(Boolean)[0] || "";
  const snippet = first && !title.startsWith(first.slice(0, 20)) ? first : "";
  return snippet ? `${title} \u2014 ${snippet.length > 60 ? `${snippet.slice(0, 60)}\u2026` : snippet}` : title;
}
var todoLine = (t) => `${t.title}${t.time ? ` (${formatTime(t.time)})` : ""}${t.priority === "high" ? " \xB7 \uC911\uC694" : ""}`;
function buildBriefing(state2, now = /* @__PURE__ */ new Date(), { clockOffsetMs = 0 } = {}) {
  const t = toISODate(now);
  const todayTodos = todosDueOn(state2, t);
  const overdue = overdueTodos(state2, t);
  const todayEvents = eventsOn(state2, t);
  const doneYesterday = todosDoneOn(state2, addDays(t, -1));
  const doneToday = todosDoneOn(state2, t);
  const upcoming = state2.todos.filter((x) => !x.done && x.due && diffDays(x.due, t) >= 1 && diffDays(x.due, t) <= 7).sort(compareTodos);
  const upcomingEvents = eventsBetween(state2, addDays(t, 1), addDays(t, 3)).filter((e) => e.date > t);
  const noDate = state2.todos.filter((x) => !x.done && !x.due);
  const since = new Date(now.getTime() - clockOffsetMs - 864e5).toISOString();
  const plainMemos = state2.memos.filter((m) => !m.tags.includes(BRIEFING_TAG));
  const recentMemos = plainMemos.filter((m) => m.updatedAt >= since).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const memoPick = recentMemos.length ? { title: "\uCD5C\uADFC \uBA54\uBAA8", list: recentMemos } : { title: "\uACE0\uC815 \uBA54\uBAA8", list: plainMemos.filter((m) => m.pinned).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) };
  const techBrief = state2.memos.filter((m) => m.tags.includes(BRIEFING_TAG)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] || null;
  const focus = [...overdue, ...todayTodos].sort((a, b) => PRIORITY_RANK2[a.priority] - PRIORITY_RANK2[b.priority] || compareTodos(a, b)).slice(0, 3);
  const parts = [];
  parts.push(todayEvents.length ? `\uC77C\uC815 ${todayEvents.length}\uAC74` : "\uC77C\uC815 \uC5C6\uC74C");
  parts.push(todayTodos.length ? `\uC624\uB298 \uD560 \uC77C ${todayTodos.length}\uAC74` : "\uC624\uB298 \uB9C8\uAC10\uC778 \uD560 \uC77C \uC5C6\uC74C");
  if (overdue.length) parts.push(`\uBBF8\uC644\uB8CC ${overdue.length}\uAC74 \uC774\uC6D4`);
  const headline = `${parts.join(", ")}.`;
  const sections = [];
  if (focus.length) {
    sections.push({ key: "focus", title: "\uC624\uB298\uC758 \uD575\uC2EC", items: focus.map((x) => x.due < t ? `${todoLine(x)} \u2014 ${diffDays(t, x.due)}\uC77C \uC9C0\uC5F0` : todoLine(x)) });
  }
  sections.push({ key: "events", title: "\uC624\uB298 \uC77C\uC815", items: todayEvents.map((e) => eventLine(e, t)), empty: "\uC608\uC815\uB41C \uC77C\uC815\uC774 \uC5C6\uC2B5\uB2C8\uB2E4." });
  sections.push({ key: "todos", title: "\uC624\uB298 \uD560 \uC77C", items: todayTodos.map(todoLine), empty: "\uC624\uB298 \uB9C8\uAC10\uC778 \uD560 \uC77C\uC774 \uC5C6\uC2B5\uB2C8\uB2E4." });
  if (overdue.length) {
    sections.push({
      key: "overdue",
      title: "\uBBF8\uC644\uB8CC \uD56D\uBAA9",
      items: overdue.map((x) => `${x.title} \u2014 ${diffDays(t, x.due)}\uC77C \uC9C0\uC5F0${x.postponed ? `, ${x.postponed}\uBC88 \uBBF8\uB8F8` : ""}`)
    });
  }
  if (upcoming.length) {
    sections.push({ key: "upcoming", title: "\uC774\uBC88 \uC8FC \uB2E4\uAC00\uC624\uB294 \uB9C8\uAC10", items: upcoming.map((x) => `${formatRelative(x.due, t)} \xB7 ${todoLine(x)}`) });
  }
  if (upcomingEvents.length) {
    sections.push({ key: "nextEvents", title: "\uC55E\uC73C\uB85C 3\uC77C \uC77C\uC815", items: upcomingEvents.map((e) => `${formatRelative(e.date, t)} \xB7 ${eventLine(e)}`) });
  }
  if (doneYesterday.length) {
    sections.push({ key: "done", title: "\uC5B4\uC81C \uC644\uB8CC", items: doneYesterday.map((x) => x.title) });
  }
  if (memoPick.list.length) {
    sections.push({
      key: "memos",
      title: memoPick.title,
      items: memoPick.list.slice(0, 5).map(memoLine),
      more: Math.max(0, memoPick.list.length - 5)
    });
  }
  if (techBrief) {
    const firstLine = techBrief.body.split("\n").map((l) => l.trim()).filter(Boolean)[0] || "";
    sections.push({
      key: "tech",
      title: "\uCD5C\uADFC \uAE30\uC220 \uBE0C\uB9AC\uD551",
      memoId: techBrief.id,
      items: [`${techBrief.title || "(\uC81C\uBAA9 \uC5C6\uC74C)"}${firstLine ? ` \u2014 ${firstLine.slice(0, 80)}` : ""}`]
    });
  }
  const md = [`# ${formatLong(t)} \uBE0C\uB9AC\uD551`, "", headline, ""];
  sections.forEach((sec) => {
    md.push(`## ${sec.title}`);
    if (sec.items.length) sec.items.forEach((i) => md.push(`- ${i}`));
    if (sec.more) md.push(`- \uC678 ${sec.more}\uAC74`);
    else md.push(`- ${sec.empty}`);
    md.push("");
  });
  return {
    date: t,
    headline,
    sections,
    markdown: `${md.join("\n").trimEnd()}
`,
    stats: {
      todayTodos: todayTodos.length,
      doneToday: doneToday.length,
      overdue: overdue.length,
      todayEvents: todayEvents.length,
      noDate: noDate.length,
      memos: memoPick.list.length
    },
    memoTitle: memoPick.title
  };
}
function buildMorningPush(state2, now = /* @__PURE__ */ new Date(), opts = {}) {
  const b = buildBriefing(state2, now, opts);
  const t = b.date;
  const todayTodos = todosDueOn(state2, t);
  const overdue = overdueTodos(state2, t);
  const memoSec = b.sections.find((x) => x.key === "memos");
  const lines = [];
  const summary = [`\uC624\uB298 \uD560 \uC77C ${b.stats.todayTodos}\uAC74`];
  if (b.stats.overdue) summary.push(`\uBBF8\uC644\uB8CC ${b.stats.overdue}\uAC74`);
  if (b.stats.todayEvents) summary.push(`\uC77C\uC815 ${b.stats.todayEvents}\uAC74`);
  lines.push(summary.join(" \xB7 "));
  todayTodos.slice(0, 3).forEach((x) => lines.push(`\u2022 ${todoLine(x)}`));
  if (todayTodos.length > 3) lines.push(`\u2022 \uC678 ${todayTodos.length - 3}\uAC74`);
  if (overdue.length) {
    const first = overdue.slice().sort((a, c) => PRIORITY_RANK2[a.priority] - PRIORITY_RANK2[c.priority] || a.due.localeCompare(c.due))[0];
    lines.push(`\uBBF8\uC644\uB8CC: ${first.title}(${diffDays(t, first.due)}\uC77C \uC9C0\uC5F0)${overdue.length > 1 ? ` \uC678 ${overdue.length - 1}\uAC74` : ""}`);
  }
  if (memoSec) {
    const n = memoSec.items.length + (memoSec.more || 0);
    lines.push(`${memoSec.title}: ${memoSec.items[0]}${n > 1 ? ` \uC678 ${n - 1}\uAC74` : ""}`);
  }
  if (!todayTodos.length && !overdue.length && !b.stats.todayEvents && !memoSec) {
    lines.push("\uC624\uB298\uC740 \uC608\uC815\uB41C \uD560 \uC77C\uC774 \uC5C6\uC2B5\uB2C8\uB2E4. \uC88B\uC740 \uD558\uB8E8 \uBCF4\uB0B4\uC138\uC694!");
  }
  const body = lines.join("\n");
  return {
    title: `${formatLong(t)} \uC544\uCE68 \uBE0C\uB9AC\uD551`,
    body: body.length > 600 ? `${body.slice(0, 600)}\u2026` : body,
    url: "./#briefing",
    tag: `briefing-${t}`
  };
}

// js/b64.js
function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 32768) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
  }
  return btoa(bin);
}
function base64ToBytes(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
var bytesToB64url = (bytes) => bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function b64urlToBytes(s) {
  const b64 = String(s).replace(/-/g, "+").replace(/_/g, "/");
  return base64ToBytes(b64 + "=".repeat((4 - b64.length % 4) % 4));
}

// cloudflare/webpush.js
var te = new TextEncoder();
var subtle = () => globalThis.crypto.subtle;
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  parts.forEach((p) => {
    out.set(p, o);
    o += p.length;
  });
  return out;
}
async function hkdf(salt, ikm, info, length) {
  const key = await subtle().importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await subtle().deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8);
  return new Uint8Array(bits);
}
async function encryptPayload(plaintext, p256dh, auth, { salt, senderKeys } = {}) {
  const uaPublic = b64urlToBytes(p256dh);
  const authSecret = b64urlToBytes(auth);
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error("\uC798\uBABB\uB41C \uAD6C\uB3C5 \uD0A4");
  const keys = senderKeys || await subtle().generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await subtle().exportKey("raw", keys.publicKey));
  const uaKey = await subtle().importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await subtle().deriveBits({ name: "ECDH", public: uaKey }, keys.privateKey, 256));
  const ikm = await hkdf(authSecret, ecdhSecret, concat(te.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const s = salt || globalThis.crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(s, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(s, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const body = typeof plaintext === "string" ? te.encode(plaintext) : plaintext;
  const aesKey = await subtle().importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: nonce }, aesKey, concat(body, new Uint8Array([2]))));
  const header = new Uint8Array(21);
  header.set(s, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  return concat(header, asPublic, cipher);
}
async function vapidAuthorization(endpoint, { subject, publicKey, privateKey }, now = Date.now()) {
  const pub = b64urlToBytes(publicKey);
  if (pub.length !== 65) throw new Error("\uC798\uBABB\uB41C VAPID \uACF5\uAC1C\uD0A4");
  const jwk = {
    kty: "EC",
    crv: "P-256",
    d: privateKey,
    x: bytesToB64url(pub.subarray(1, 33)),
    y: bytesToB64url(pub.subarray(33, 65)),
    ext: true
  };
  const key = await subtle().importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const enc = (o) => bytesToB64url(te.encode(JSON.stringify(o)));
  const unsigned = `${enc({ typ: "JWT", alg: "ES256" })}.${enc({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1e3) + 12 * 3600,
    sub: subject
  })}`;
  const sig = new Uint8Array(await subtle().sign({ name: "ECDSA", hash: "SHA-256" }, key, te.encode(unsigned)));
  return `vapid t=${unsigned}.${bytesToB64url(sig)}, k=${publicKey}`;
}
async function sendWebPush(subscription, payload, vapid, { ttl = 3600, urgency = "high", topic, fetchImpl = fetch } = {}) {
  const body = await encryptPayload(payload, subscription.keys.p256dh, subscription.keys.auth);
  const headers = {
    TTL: String(ttl),
    Urgency: urgency,
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    Authorization: await vapidAuthorization(subscription.endpoint, vapid)
  };
  if (topic) headers.Topic = topic.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  const res = await fetchImpl(subscription.endpoint, { method: "POST", headers, body });
  return { ok: res.ok, status: res.status, expired: res.status === 404 || res.status === 410 };
}

// cloudflare/worker.js
var DATA_PATH = "data/assistant.json";
var DEFAULTS = {
  DATA_REPO: "DanielPark83/Obsidian-mobile",
  DATA_BRANCH: "claude/festive-carson-m3r30t",
  TZ_OFFSET_MINUTES: "540",
  BRIEFING_TIME: "08:00",
  VAPID_SUBJECT: "https://danielpark83.github.io/daniel-assistant/"
};
function targets(state2) {
  if (!state2.vapid) return [];
  return Object.entries(state2.devices).filter(([, d]) => d.push && d.vapidKey === state2.vapid.publicKey).map(([id, d]) => ({ id, label: d.label, subscription: d.push }));
}
var hhmm = (d) => `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
function messagesFor(state2, scheduledTime, { offsetMinutes = 540, briefingTime = "08:00" } = {}) {
  const offset = offsetMinutes * 6e4;
  const wall = Math.floor((scheduledTime + offset) / 6e4) * 6e4;
  const now = new Date(wall);
  const out = dueReminders(state2, new Date(wall - 6e4), now).map((r) => ({
    kind: "reminder",
    title: r.title,
    body: r.body,
    url: r.url,
    tag: r.key
  }));
  if (briefingTime && briefingTime !== "off" && hhmm(now) === briefingTime) {
    const b = buildMorningPush(state2, now, { clockOffsetMs: offset });
    out.push({ kind: "briefing", title: b.title, body: b.body, url: b.url, tag: b.tag });
  }
  return out;
}
async function loadState(env, fetchImpl) {
  const url = `https://api.github.com/repos/${env.DATA_REPO}/contents/${DATA_PATH}?ref=${encodeURIComponent(env.DATA_BRANCH || "main")}`;
  const res = await fetchImpl(url, {
    headers: {
      Accept: "application/vnd.github.raw+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "daniel-assistant-notifier",
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  return normalize(await res.json());
}
async function run(rawEnv, scheduledTime, fetchImpl = fetch) {
  const env = { ...DEFAULTS, ...Object.fromEntries(Object.entries(rawEnv || {}).filter(([, v]) => v !== void 0 && v !== "")) };
  if (!env.GITHUB_TOKEN) return { skipped: "not-configured" };
  const state2 = await loadState(env, fetchImpl);
  if (!state2) return { skipped: "no-data" };
  const list = targets(state2);
  if (!list.length) return { skipped: "no-devices" };
  const messages = messagesFor(state2, scheduledTime, {
    offsetMinutes: Number(env.TZ_OFFSET_MINUTES ?? 540),
    briefingTime: env.BRIEFING_TIME ?? "08:00"
  });
  if (!messages.length) return { sent: 0 };
  const vapid = { subject: env.VAPID_SUBJECT, publicKey: state2.vapid.publicKey, privateKey: state2.vapid.privateKey };
  const results = [];
  for (const m of messages) {
    const payload = JSON.stringify({ title: m.title, body: m.body, url: m.url, tag: m.tag });
    for (const t of list) {
      try {
        const r = await sendWebPush(t.subscription, payload, vapid, {
          ttl: m.kind === "briefing" ? 6 * 3600 : 1800,
          urgency: "high",
          fetchImpl
        });
        results.push({ kind: m.kind, device: t.label, ...r });
      } catch (err) {
        results.push({ kind: m.kind, device: t.label, ok: false, error: String(err && err.message || err) });
      }
    }
  }
  console.log(JSON.stringify({ at: new Date(scheduledTime).toISOString(), results: results.map(({ kind, device, ok, status, expired, error }) => ({ kind, device, ok, status, expired, error })) }));
  return { sent: results.filter((r) => r.ok).length, results };
}
var worker_default = {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env, event.scheduledTime).catch((err) => console.log(`\uC2E4\uD328: ${err.message}`)));
  },
  // 주소로 열면 설정 상태만 알려 준다(내용은 보여 주지 않는다)
  async fetch(request, rawEnv) {
    const env = { ...DEFAULTS, ...rawEnv };
    let state2 = "\uC124\uC815 \uD544\uC694: Settings \u2192 Variables and Secrets\uC5D0 GITHUB_TOKEN(Secret)\uC744 \uB123\uC5B4 \uC8FC\uC138\uC694.";
    if (env.GITHUB_TOKEN) {
      try {
        const s = await loadState(env, fetch);
        state2 = s ? `\uC815\uC0C1 \u2014 \uB370\uC774\uD130\uB97C \uC77D\uC5C8\uC2B5\uB2C8\uB2E4. \uC54C\uB9BC \uBC1B\uB294 \uAE30\uAE30 ${targets(s).length}\uB300` : "\uB370\uC774\uD130 \uD30C\uC77C\uC774 \uC544\uC9C1 \uC5C6\uC2B5\uB2C8\uB2E4(\uC571\uC5D0\uC11C \uB3D9\uAE30\uD654\uB97C \uC5F0\uACB0\uD574 \uC8FC\uC138\uC694).";
      } catch (err) {
        state2 = `\uB370\uC774\uD130\uB97C \uC77D\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4(${err.message}). \uD1A0\uD070 \uAD8C\uD55C(Obsidian-mobile, Contents: Read-only)\uC744 \uD655\uC778\uD574 \uC8FC\uC138\uC694.`;
      }
    }
    return new Response(`Daniel's \uAC1C\uC778 \uBE44\uC11C \uC54C\uB9BC \uBC1C\uC1A1\uAE30
\uC0C1\uD0DC: ${state2}
`, { headers: { "content-type": "text/plain; charset=utf-8" } });
  }
};
export {
  worker_default as default,
  messagesFor,
  run,
  targets
};
