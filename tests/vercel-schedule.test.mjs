import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('Vercel invokes each supported India reminder slot once daily with an explicit slot', () => {
  const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  const expected = ['09', '11', '12', '13', '15', '17', '18', '19', '21'];
  const slots = [];
  for (const job of config.crons) {
    const url = new URL(job.path, 'https://example.test');
    assert.equal(url.pathname, '/api/cron/reminders');
    const slot = url.searchParams.get('hour');
    slots.push(slot);
    const [minute, hour, day, month, weekday] = job.schedule.split(' ');
    assert.deepEqual([day, month, weekday], ['*', '*', '*']);
    const indiaMinutes = (Number(hour) * 60 + Number(minute) + 330) % 1440;
    assert.equal(indiaMinutes, Number(slot) * 60, 'UTC trigger must correspond to its India time slot');
  }
  assert.deepEqual(slots.sort(), expected);
});
