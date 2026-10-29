function bounded<T>(promise: Promise<T>, message: string, ms = 10_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

// Status checks must not wait for a registration that may not exist yet.
export function existingReminderRegistration(container: ServiceWorkerContainer) {
  return bounded(container.getRegistration(), "Reminder status timed out. You can try turning notifications on again.");
}

export async function readyReminderRegistration(container: ServiceWorkerContainer) {
  const registration = await bounded(container.register("/sw.js", { updateViaCache: "none" }), "Notification setup timed out. Reload and try again.");
  if (registration.active) return registration;
  return bounded(container.ready, "Notification service did not become active. Reload and try again.");
}
