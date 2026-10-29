import assert from 'node:assert/strict';
import { existingReminderRegistration, readyReminderRegistration } from '../app/notification-client';
const never = new Promise<ServiceWorkerRegistration>(() => {});
const active = { active: {} } as ServiceWorkerRegistration;
assert.equal(await existingReminderRegistration({ getRegistration: async () => undefined, ready: never } as unknown as ServiceWorkerContainer), undefined);
assert.equal(await readyReminderRegistration({ register: async () => active, ready: never } as unknown as ServiceWorkerContainer), active);
assert.equal(await readyReminderRegistration({ register: async () => ({ active: null }), ready: Promise.resolve(active) } as unknown as ServiceWorkerContainer), active);
await assert.rejects(readyReminderRegistration({ register: async () => { throw new Error('Registration blocked'); } } as unknown as ServiceWorkerContainer), /Registration blocked/);
console.log('Reminder registration checks passed: fresh device, active worker, activation, registration failure.');
