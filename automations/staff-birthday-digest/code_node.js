/**
 * Дни рождения сотрудников школы → письмо директору.
 *
 * Вход:  строки Excel из ноды "Extract From File" (headerRow = false, rawData = true)
 * Выход: ровно один item { send, count, subject, html, text, debug }
 *
 * Ноду "Send Email" запускаем только если send === true.
 */

// ─────────── Настройки (правятся прямо здесь) ───────────
const TZ = 'Europe/Moscow'; // по какому времени считается «сегодня»
const LEAD_DAYS = 3; // за сколько дней предупреждать заранее
const SHOW_PHONE = true; // показывать мобильный телефон в письме
const SCHOOL = 'ГБОУ Школа № 0000';
const JUBILEE_FROM = 50; // с какого возраста круглые даты помечать как юбилей

// ─────────── 1. Приводим вход к массиву строк ───────────
const rows = $input.all().map((item) => {
  const j = item.json ?? {};
  if (Array.isArray(j)) return j;
  if (Array.isArray(j.row)) return j.row;
  return Object.values(j);
});

// ─────────── 2. Ищем колонки по заголовкам ───────────
// Так выгрузка из 1С может менять расположение столбцов — система не сломается.
const HEAD = {
  name: ['сотрудник', 'фио', 'ф.и.о.', 'сотрудники'],
  dob: ['дата рождения', 'дата рождения сотрудника'],
  post: ['должность'],
  phone: ['физическое лицо.мобильный телефон', 'мобильный телефон', 'телефон'],
};
const col = { name: 0, dob: 3, post: 6, phone: 11 }; // запасной вариант — текущий формат выгрузки
let headerRow = -1;

rows.forEach((r, i) =>
  r.forEach((cell, c) => {
    const t = String(cell ?? '')
      .trim()
      .toLowerCase();
    if (!t) return;
    for (const key of Object.keys(HEAD)) {
      if (HEAD[key].includes(t)) {
        col[key] = c;
        headerRow = Math.max(headerRow, i);
      }
    }
  }),
);

// ─────────── 3. Разбор дат (ISO, дд.мм.гггг, серийный номер Excel) ───────────
function parseDate(v) {
  if (v === null || v === undefined || v === '') return null;

  if (v instanceof Date && !isNaN(v)) {
    return new Date(Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate()));
  }
  if (typeof v === 'number') {
    // серийная дата Excel: 1 = 01.01.1900, точка отсчёта 30.12.1899
    return new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
  }

  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); // 1983-04-17 / 1983-04-17T00:00:00.000Z
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));

  m = s.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})/); // 17.04.1983
  if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));

  const d = new Date(s);
  return isNaN(d) ? null : new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// ─────────── 4. Собираем список сотрудников ───────────
const cell = (r, i) => (i != null && i < r.length ? r[i] : null);
const people = [];

for (const r of rows.slice(headerRow + 1)) {
  const name = String(cell(r, col.name) ?? '').trim();
  const dob = parseDate(cell(r, col.dob));
  if (!name || !dob) continue;

  people.push({
    name,
    dob,
    post: String(cell(r, col.post) ?? '').trim(),
    phone: String(cell(r, col.phone) ?? '').trim(),
  });
}

// ─────────── 5. Сегодня и «через LEAD_DAYS дней» в нужном часовом поясе ───────────
const p = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})
  .format(new Date())
  .split('-')
  .map(Number);

const today = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
const soon = new Date(today.getTime() + LEAD_DAYS * 86400000);

// ─────────── 6. Кто именинник ───────────
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

function matches(dob, day) {
  if (dob.getUTCMonth() === day.getUTCMonth() && dob.getUTCDate() === day.getUTCDate()) return true;
  // родившихся 29 февраля в невисокосный год поздравляем 28-го
  if (dob.getUTCMonth() === 1 && dob.getUTCDate() === 29 && !isLeap(day.getUTCFullYear())) {
    return day.getUTCMonth() === 1 && day.getUTCDate() === 28;
  }
  return false;
}

function yearsWord(n) {
  if (n % 10 === 1 && n % 100 !== 11) return 'год';
  if (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14)) return 'года';
  return 'лет';
}

function daysWord(n) {
  if (n % 10 === 1 && n % 100 !== 11) return 'день';
  if (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14)) return 'дня';
  return 'дней';
}

function collect(day) {
  return people
    .filter((x) => matches(x.dob, day))
    .map((x) => {
      const age = day.getUTCFullYear() - x.dob.getUTCFullYear();
      return {
        ...x,
        age,
        ageText: `${age} ${yearsWord(age)}`,
        jubilee: age >= JUBILEE_FROM && age % 5 === 0,
        dobText: `${String(x.dob.getUTCDate()).padStart(2, '0')}.${String(x.dob.getUTCMonth() + 1).padStart(2, '0')}.${x.dob.getUTCFullYear()}`,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

const todayList = collect(today);
const soonList = collect(soon);
const count = todayList.length + soonList.length;

// ─────────── 7. Если базу прочитать не удалось — предупреждаем ───────────
const fmtDay = (d) =>
  new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', day: 'numeric', month: 'long' }).format(d);
const fmtWeekday = (d) =>
  new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', weekday: 'long' }).format(d);

if (people.length === 0) {
  return [
    {
      json: {
        send: true,
        alert: true,
        count: 0,
        subject: '⚠️ Напоминание о днях рождения: не удалось прочитать базу',
        text: 'Файл базы прочитан, но ни одной записи с ФИО и датой рождения не найдено. Проверьте формат файла.',
        html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#222">
<p><b>Не удалось прочитать базу дней рождения.</b></p>
<p>Файл открылся, но ни одной строки с ФИО и датой рождения в нём не найдено — вероятно, изменился формат выгрузки.</p>
<p>Получено строк из файла: ${rows.length}. Строка заголовка: ${headerRow + 1}.</p>
<p style="color:#666">Сегодняшние напоминания не отправлены.</p></div>`,
        debug: { rows: rows.length, headerRow: headerRow + 1, col },
      },
    },
  ];
}

// ─────────── 8. Ничего не отправляем, если именинников нет ───────────
if (count === 0) {
  return [
    {
      json: {
        send: false,
        count: 0,
        subject: '',
        html: '',
        text: '',
        debug: { people: people.length, headerRow: headerRow + 1, col },
      },
    },
  ];
}

// ─────────── 9. Письмо ───────────
function card(x) {
  const badge = x.jubilee
    ? ' <span style="background:#fff2cc;border:1px solid #e0c200;border-radius:3px;padding:1px 6px;font-size:12px">ЮБИЛЕЙ</span>'
    : '';
  const phone =
    SHOW_PHONE && x.phone
      ? `<div style="color:#666;font-size:13px;margin-top:2px">тел. ${x.phone}</div>`
      : '';
  return `<tr><td style="padding:10px 12px;border-bottom:1px solid #eee">
<div style="font-size:16px"><b>${x.name}</b>${badge}</div>
<div style="color:#444;font-size:14px;margin-top:2px">${x.post || '—'}</div>
<div style="color:#444;font-size:14px;margin-top:2px">исполняется <b>${x.ageText}</b> <span style="color:#888">(род. ${x.dobText})</span></div>
${phone}</td></tr>`;
}

function block(title, list, color) {
  if (!list.length) return '';
  return `<div style="margin:0 0 22px">
<div style="background:${color};color:#fff;padding:8px 12px;font-size:15px;border-radius:4px 4px 0 0"><b>${title}</b></div>
<table style="border-collapse:collapse;width:100%;border:1px solid #eee;border-top:none">${list.map(card).join('')}</table>
</div>`;
}

const lead = `${LEAD_DAYS} ${daysWord(LEAD_DAYS)}`;

// «Андреева Ольга Петровна» -> «Андреева О.П.» (для темы письма)
function shortName(full) {
  const parts = String(full).trim().split(/\s+/);
  const last = parts[0];
  const initials = parts
    .slice(1, 3)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + '.')
    .join('');
  return initials ? `${last} ${initials}` : last;
}
const short = (list) => list.map((x) => shortName(x.name)).join(', ');

const subjParts = [];
if (todayList.length) subjParts.push(`сегодня — ${short(todayList)}`);
if (soonList.length) subjParts.push(`через ${lead} — ${short(soonList)}`);

const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#222;max-width:640px">
<div style="font-size:18px;margin:0 0 16px"><b>Дни рождения сотрудников</b><br>
<span style="color:#666;font-size:14px">${SCHOOL} · ${fmtDay(today)}</span></div>
${block(`Сегодня, ${fmtDay(today)}`, todayList, '#c0392b')}
${block(`Через ${lead} — ${fmtDay(soon)}, ${fmtWeekday(soon)}`, soonList, '#2c7a3f')}
<div style="color:#999;font-size:12px;border-top:1px solid #eee;padding-top:10px">
Автоматическое напоминание. В базе ${people.length} сотрудников.</div></div>`;

const line = (x) =>
  `  • ${x.name} — ${x.post} — исполняется ${x.ageText}${x.jubilee ? ' (ЮБИЛЕЙ)' : ''}`;

const text = [
  todayList.length ? `СЕГОДНЯ (${fmtDay(today)}):` : '',
  ...todayList.map(line),
  soonList.length ? `\nЧЕРЕЗ ${lead.toUpperCase()} (${fmtDay(soon)}, ${fmtWeekday(soon)}):` : '',
  ...soonList.map(line),
]
  .filter(Boolean)
  .join('\n');

return [
  {
    json: {
      send: true,
      alert: false,
      count,
      subject: `🎂 Дни рождения: ${subjParts.join('; ')}`,
      html,
      text,
      debug: { people: people.length, headerRow: headerRow + 1, col, leadDays: LEAD_DAYS },
    },
  },
];
