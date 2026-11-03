/** `p`, or a rejection ("timed out after Nms") once `ms` pass: for reads that must not hang a caller (an engine call to
 *  an actor that is waking up can retry for minutes). The call itself isn't stopped; its result is dropped. */
export function within<T>(p: Promise<T>, ms: number, what = "the call"): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<T>((_, no) => { timer = setTimeout(() => no(new Error(`${what} timed out after ${ms}ms`)), ms); })]).finally(() => clearTimeout(timer));
}
