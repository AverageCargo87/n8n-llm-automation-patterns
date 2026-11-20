import { workflow, node, trigger, ifElse, sticky, newCredential, expr } from '@n8n/workflow-sdk';

const smtpCred = newCredential('mail.ru SMTP');

const dailyTrigger = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.2,
  config: {
    name: 'Каждый день в 08:00',
    parameters: {
      rule: { interval: [{ field: 'days', triggerAtHour: 8, triggerAtMinute: 0 }] }
    }
  }
});

const readBase = node({
  type: 'n8n-nodes-base.readWriteFile',
  version: 1,
  config: {
    name: 'Читать базу с диска',
    parameters: { operation: 'read', fileSelector: "/home/node/.n8n-files/employees.xlsx", options: {} },
    onError: 'continueErrorOutput'
  }
});

const toRows = node({
  type: 'n8n-nodes-base.extractFromFile',
  version: 1,
  config: {
    name: 'Excel в строки',
    parameters: { operation: 'xlsx', options: { headerRow: false, rawData: true } }
  }
});

const findBirthdays = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Найти именинников',
    parameters: { mode: 'runOnceForAllItems', jsCode: "/**\n * Дни рождения сотрудников школы → письмо директору.\n *\n * Вход:  строки Excel из ноды \"Extract From File\" (headerRow = false, rawData = true)\n * Выход: ровно один item { send, count, subject, html, text, debug }\n *\n * Ноду \"Send Email\" запускаем только если send === true.\n */\n\n// ─────────── Настройки (правятся прямо здесь) ───────────\nconst TZ = 'Europe/Moscow'; // по какому времени считается «сегодня»\nconst LEAD_DAYS = 3; // за сколько дней предупреждать заранее\nconst SHOW_PHONE = true; // показывать мобильный телефон в письме\nconst SCHOOL = 'ГБОУ Школа № 0000';\nconst JUBILEE_FROM = 50; // с какого возраста круглые даты помечать как юбилей\n\n// ─────────── 1. Приводим вход к массиву строк ───────────\nconst rows = $input.all().map((item) => {\n  const j = item.json ?? {};\n  if (Array.isArray(j)) return j;\n  if (Array.isArray(j.row)) return j.row;\n  return Object.values(j);\n});\n\n// ─────────── 2. Ищем колонки по заголовкам ───────────\n// Так выгрузка из 1С может менять расположение столбцов — система не сломается.\nconst HEAD = {\n  name: ['сотрудник', 'фио', 'ф.и.о.', 'сотрудники'],\n  dob: ['дата рождения', 'дата рождения сотрудника'],\n  post: ['должность'],\n  phone: ['физическое лицо.мобильный телефон', 'мобильный телефон', 'телефон'],\n};\nconst col = { name: 0, dob: 3, post: 6, phone: 11 }; // запасной вариант — текущий формат выгрузки\nlet headerRow = -1;\n\nrows.forEach((r, i) =>\n  r.forEach((cell, c) => {\n    const t = String(cell ?? '')\n      .trim()\n      .toLowerCase();\n    if (!t) return;\n    for (const key of Object.keys(HEAD)) {\n      if (HEAD[key].includes(t)) {\n        col[key] = c;\n        headerRow = Math.max(headerRow, i);\n      }\n    }\n  }),\n);\n\n// ─────────── 3. Разбор дат (ISO, дд.мм.гггг, серийный номер Excel) ───────────\nfunction parseDate(v) {\n  if (v === null || v === undefined || v === '') return null;\n\n  if (v instanceof Date && !isNaN(v)) {\n    return new Date(Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate()));\n  }\n  if (typeof v === 'number') {\n    // серийная дата Excel: 1 = 01.01.1900, точка отсчёта 30.12.1899\n    return new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);\n  }\n\n  const s = String(v).trim();\n  let m = s.match(/^(\\d{4})-(\\d{1,2})-(\\d{1,2})/); // 1983-04-17 / 1983-04-17T00:00:00.000Z\n  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));\n\n  m = s.match(/^(\\d{1,2})[.\\/-](\\d{1,2})[.\\/-](\\d{4})/); // 17.04.1983\n  if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));\n\n  const d = new Date(s);\n  return isNaN(d) ? null : new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));\n}\n\n// ─────────── 4. Собираем список сотрудников ───────────\nconst cell = (r, i) => (i != null && i < r.length ? r[i] : null);\nconst people = [];\n\nfor (const r of rows.slice(headerRow + 1)) {\n  const name = String(cell(r, col.name) ?? '').trim();\n  const dob = parseDate(cell(r, col.dob));\n  if (!name || !dob) continue;\n\n  people.push({\n    name,\n    dob,\n    post: String(cell(r, col.post) ?? '').trim(),\n    phone: String(cell(r, col.phone) ?? '').trim(),\n  });\n}\n\n// ─────────── 5. Сегодня и «через LEAD_DAYS дней» в нужном часовом поясе ───────────\nconst p = new Intl.DateTimeFormat('en-CA', {\n  timeZone: TZ,\n  year: 'numeric',\n  month: '2-digit',\n  day: '2-digit',\n})\n  .format(new Date())\n  .split('-')\n  .map(Number);\n\nconst today = new Date(Date.UTC(p[0], p[1] - 1, p[2]));\nconst soon = new Date(today.getTime() + LEAD_DAYS * 86400000);\n\n// ─────────── 6. Кто именинник ───────────\nconst isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;\n\nfunction matches(dob, day) {\n  if (dob.getUTCMonth() === day.getUTCMonth() && dob.getUTCDate() === day.getUTCDate()) return true;\n  // родившихся 29 февраля в невисокосный год поздравляем 28-го\n  if (dob.getUTCMonth() === 1 && dob.getUTCDate() === 29 && !isLeap(day.getUTCFullYear())) {\n    return day.getUTCMonth() === 1 && day.getUTCDate() === 28;\n  }\n  return false;\n}\n\nfunction yearsWord(n) {\n  if (n % 10 === 1 && n % 100 !== 11) return 'год';\n  if (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14)) return 'года';\n  return 'лет';\n}\n\nfunction daysWord(n) {\n  if (n % 10 === 1 && n % 100 !== 11) return 'день';\n  if (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14)) return 'дня';\n  return 'дней';\n}\n\nfunction collect(day) {\n  return people\n    .filter((x) => matches(x.dob, day))\n    .map((x) => {\n      const age = day.getUTCFullYear() - x.dob.getUTCFullYear();\n      return {\n        ...x,\n        age,\n        ageText: `${age} ${yearsWord(age)}`,\n        jubilee: age >= JUBILEE_FROM && age % 5 === 0,\n        dobText: `${String(x.dob.getUTCDate()).padStart(2, '0')}.${String(x.dob.getUTCMonth() + 1).padStart(2, '0')}.${x.dob.getUTCFullYear()}`,\n      };\n    })\n    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));\n}\n\nconst todayList = collect(today);\nconst soonList = collect(soon);\nconst count = todayList.length + soonList.length;\n\n// ─────────── 7. Если базу прочитать не удалось — предупреждаем ───────────\nconst fmtDay = (d) =>\n  new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', day: 'numeric', month: 'long' }).format(d);\nconst fmtWeekday = (d) =>\n  new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', weekday: 'long' }).format(d);\n\nif (people.length === 0) {\n  return [\n    {\n      json: {\n        send: true,\n        alert: true,\n        count: 0,\n        subject: '⚠️ Напоминание о днях рождения: не удалось прочитать базу',\n        text: 'Файл базы прочитан, но ни одной записи с ФИО и датой рождения не найдено. Проверьте формат файла.',\n        html: `<div style=\"font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#222\">\n<p><b>Не удалось прочитать базу дней рождения.</b></p>\n<p>Файл открылся, но ни одной строки с ФИО и датой рождения в нём не найдено — вероятно, изменился формат выгрузки.</p>\n<p>Получено строк из файла: ${rows.length}. Строка заголовка: ${headerRow + 1}.</p>\n<p style=\"color:#666\">Сегодняшние напоминания не отправлены.</p></div>`,\n        debug: { rows: rows.length, headerRow: headerRow + 1, col },\n      },\n    },\n  ];\n}\n\n// ─────────── 8. Ничего не отправляем, если именинников нет ───────────\nif (count === 0) {\n  return [\n    {\n      json: {\n        send: false,\n        count: 0,\n        subject: '',\n        html: '',\n        text: '',\n        debug: { people: people.length, headerRow: headerRow + 1, col },\n      },\n    },\n  ];\n}\n\n// ─────────── 9. Письмо ───────────\nfunction card(x) {\n  const badge = x.jubilee\n    ? ' <span style=\"background:#fff2cc;border:1px solid #e0c200;border-radius:3px;padding:1px 6px;font-size:12px\">ЮБИЛЕЙ</span>'\n    : '';\n  const phone =\n    SHOW_PHONE && x.phone\n      ? `<div style=\"color:#666;font-size:13px;margin-top:2px\">тел. ${x.phone}</div>`\n      : '';\n  return `<tr><td style=\"padding:10px 12px;border-bottom:1px solid #eee\">\n<div style=\"font-size:16px\"><b>${x.name}</b>${badge}</div>\n<div style=\"color:#444;font-size:14px;margin-top:2px\">${x.post || '—'}</div>\n<div style=\"color:#444;font-size:14px;margin-top:2px\">исполняется <b>${x.ageText}</b> <span style=\"color:#888\">(род. ${x.dobText})</span></div>\n${phone}</td></tr>`;\n}\n\nfunction block(title, list, color) {\n  if (!list.length) return '';\n  return `<div style=\"margin:0 0 22px\">\n<div style=\"background:${color};color:#fff;padding:8px 12px;font-size:15px;border-radius:4px 4px 0 0\"><b>${title}</b></div>\n<table style=\"border-collapse:collapse;width:100%;border:1px solid #eee;border-top:none\">${list.map(card).join('')}</table>\n</div>`;\n}\n\nconst lead = `${LEAD_DAYS} ${daysWord(LEAD_DAYS)}`;\n\n// «Андреева Ольга Петровна» -> «Андреева О.П.» (для темы письма)\nfunction shortName(full) {\n  const parts = String(full).trim().split(/\\s+/);\n  const last = parts[0];\n  const initials = parts\n    .slice(1, 3)\n    .filter(Boolean)\n    .map((w) => w[0].toUpperCase() + '.')\n    .join('');\n  return initials ? `${last} ${initials}` : last;\n}\nconst short = (list) => list.map((x) => shortName(x.name)).join(', ');\n\nconst subjParts = [];\nif (todayList.length) subjParts.push(`сегодня — ${short(todayList)}`);\nif (soonList.length) subjParts.push(`через ${lead} — ${short(soonList)}`);\n\nconst html = `<div style=\"font-family:Arial,Helvetica,sans-serif;color:#222;max-width:640px\">\n<div style=\"font-size:18px;margin:0 0 16px\"><b>Дни рождения сотрудников</b><br>\n<span style=\"color:#666;font-size:14px\">${SCHOOL} · ${fmtDay(today)}</span></div>\n${block(`Сегодня, ${fmtDay(today)}`, todayList, '#c0392b')}\n${block(`Через ${lead} — ${fmtDay(soon)}, ${fmtWeekday(soon)}`, soonList, '#2c7a3f')}\n<div style=\"color:#999;font-size:12px;border-top:1px solid #eee;padding-top:10px\">\nАвтоматическое напоминание. В базе ${people.length} сотрудников.</div></div>`;\n\nconst line = (x) =>\n  `  • ${x.name} — ${x.post} — исполняется ${x.ageText}${x.jubilee ? ' (ЮБИЛЕЙ)' : ''}`;\n\nconst text = [\n  todayList.length ? `СЕГОДНЯ (${fmtDay(today)}):` : '',\n  ...todayList.map(line),\n  soonList.length ? `\\nЧЕРЕЗ ${lead.toUpperCase()} (${fmtDay(soon)}, ${fmtWeekday(soon)}):` : '',\n  ...soonList.map(line),\n]\n  .filter(Boolean)\n  .join('\\n');\n\nreturn [\n  {\n    json: {\n      send: true,\n      alert: false,\n      count,\n      subject: `🎂 Дни рождения: ${subjParts.join('; ')}`,\n      html,\n      text,\n      debug: { people: people.length, headerRow: headerRow + 1, col, leadDays: LEAD_DAYS },\n    },\n  },\n];\n" }
  }
});

const sendMail = node({
  type: 'n8n-nodes-base.emailSend',
  version: 2.1,
  config: {
    name: 'Письмо директору',
    parameters: {
      fromEmail: "Школа · напоминания <robot@example.com>",
      toEmail: "director@example.com",
      subject: expr('{{ $json.subject }}'),
      emailFormat: 'both',
      text: expr('{{ $json.text }}'),
      html: expr('{{ $json.html }}'),
      options: { appendAttribution: false }
    },
    credentials: { smtp: smtpCred }
  }
});

const sendAlert = node({
  type: 'n8n-nodes-base.emailSend',
  version: 2.1,
  config: {
    name: 'Тревога: база недоступна',
    parameters: {
      fromEmail: "Школа · напоминания <robot@example.com>",
      toEmail: "alerts@example.com",
      subject: 'Напоминания о днях рождения: файл базы не найден',
      emailFormat: 'text',
      text: "=Не удалось прочитать файл базы:\\n/home/node/.n8n-files/employees.xlsx\\n\\nОшибка: {{ $json.error || 'файл недоступен' }}\\n\\nНапоминания на сегодня не отправлены. Проверьте, что файл на месте.",
      options: { appendAttribution: false }
    },
    credentials: { smtp: smtpCred }
  }
});

const hasBirthdays = ifElse({
  version: 2.2,
  config: {
    name: 'Есть кого поздравлять?',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [
          {
            leftValue: expr('{{ $json.send }}'),
            operator: { type: 'boolean', operation: 'true', singleValue: true },
            rightValue: ''
          }
        ],
        combinator: 'and'
      }
    }
  }
});

const help = sticky("## Дни рождения сотрудников\\n\\nБаза: `/home/node/.n8n-files/employees.xlsx` внутри контейнера n8n.\\nОбновление — положить новый .xlsx на то же место (`tools/update_db.sh`).\\n\\n**Перед включением:**\\n1. Заполнить креденшл `mail.ru SMTP` (smtp.mail.ru:465, SSL, пароль для внешних приложений).\\n2. Заменить `Школа · напоминания <robot@example.com>` на ящик робота.\\n3. Получатель сейчас `director@example.com` — поменять на почту директора.\\n\\nПисьмо уходит каждый день в 08:00, только если есть именинники сегодня или через 3 дня.", [dailyTrigger, readBase, toRows, findBirthdays, hasBirthdays, sendMail, sendAlert], { color: 4 });

export default workflow('school-birthdays', 'Дни рождения сотрудников — напоминание директору')
  .add(dailyTrigger)
  .to(readBase.onError(sendAlert))
  .to(toRows)
  .to(findBirthdays)
  .to(hasBirthdays.onTrue(sendMail))
  .add(help);
