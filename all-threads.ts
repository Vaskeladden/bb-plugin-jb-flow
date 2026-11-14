/** How many threads bb returns per call. */
export const THREAD_PAGE = 500;

/**
 * Every thread bb lists, read page by page. bb returns one page per call, so
 * a single call leaves out the rest without a word once there are more
 * threads than a page holds (archived ones count), and a live thread missing
 * from the list has no state, no PR and no place in the counts.
 */
export async function everyThread<T>(list: (page: { limit: number; offset: number }) => Promise<T[]>): Promise<T[]> {
  const threads: T[] = [];
  for (let offset = 0; ; offset += THREAD_PAGE) {
    const page = await list({ limit: THREAD_PAGE, offset });
    threads.push(...page);
    if (page.length < THREAD_PAGE) return threads;
  }
}
