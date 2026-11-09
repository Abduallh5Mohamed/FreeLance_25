/** Deadline covers response parsing, including transports ignoring AbortSignal. */
export async function boundedRequest<T>(controller: AbortController, work: () => Promise<T>): Promise<T> {
  if (controller.signal.aborted) throw Error('Request interrupted');
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(Error('Request interrupted'));
    controller.signal.addEventListener('abort', abort, { once: true });
    timeout = setTimeout(() => controller.abort(), 25000);
  });
  try { return await Promise.race([work(), interrupted]); }
  finally {
    if (timeout !== undefined) clearTimeout(timeout);
    controller.signal.removeEventListener('abort', abort);
  }
}
