// Прогон code_node.js вне n8n: подменяем $input и текущую дату.
import { readFileSync } from 'node:fs';
const code = readFileSync(new URL('../code_node.js', import.meta.url), 'utf8');
const rows = JSON.parse(readFileSync(new URL('./rows.sample.json', import.meta.url), 'utf8'));

const run = (items, iso) => {
  const FakeDate = new Proxy(Date, {
    construct: (T, a) => (a.length ? new T(...a) : new T(iso)),
  });
  const fn = new Function('$input', 'Date', code);
  return fn({ all: () => items.map((j) => ({ json: j })) }, FakeDate)[0].json;
};

const cases = [
  ['2026-08-25T05:00:00Z', 'канун ДР 26.08'],
  ['2026-08-26T05:00:00Z', 'день ДР 26.08'],
  ['2026-08-27T05:00:00Z', 'канун двойного ДР 28.08'],
  ['2026-08-29T05:00:00Z', 'ДР 29.08 + канун юбилея 30.08'],
  ['2026-10-06T05:00:00Z', 'день без ДР (ожидаем send=false)'],
  ['2027-02-25T05:00:00Z', 'ДР 29.02 в невисокосный год: напомнить о 28.02'],
];
for (const [iso, label] of cases) {
  const r = run(rows, iso);
  console.log(`\n=== ${iso.slice(0, 10)} — ${label}`);
  console.log(`send=${r.send} count=${r.count} | ${r.subject || '(письма нет)'}`);
  if (r.text) console.log(r.text.split('\n').map((l) => '    ' + l).join('\n'));
}
console.log('\n=== пустой вход (ожидаем alert)');
const empty = run([], '2026-08-25T05:00:00Z');
console.log(`send=${empty.send} alert=${empty.alert} | ${empty.subject}`);
console.log('\n=== диагностика разбора:', JSON.stringify(run(rows, '2026-08-26T05:00:00Z').debug));
