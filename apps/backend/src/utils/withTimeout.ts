/**
 * Race a promise against a deadline, rejecting with the caller's error when
 * the deadline wins. For SDK calls that accept no AbortSignal (Firebase
 * Admin's verifyIdToken is the motivating case) — everything that CAN take a
 * signal should use `AbortSignal.timeout()` instead, like notificationWorker
 * does.
 *
 * The timer is always cleared, so a resolved race never holds the event loop
 * open. The underlying operation is NOT cancelled — it settles in the
 * background and its result is discarded; callers must not race operations
 * whose late success would need handling.
 */
export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Error
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    // Deliberately NOT unref'd: the timer lives at most `timeoutMs` and both
    // entrypoints exit via an explicit process.exit, so it can never wedge a
    // shutdown — while an unref'd timer can silently never fire when the
    // event loop is otherwise empty (which is exactly a hung-dependency
    // scenario, the one time this deadline must fire).
    timer = setTimeout(() => reject(onTimeout()), timeoutMs);
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
