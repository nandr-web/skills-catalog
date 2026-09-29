// A function opens what it serves with once per container, on its first request. An open that succeeds is kept; one
// that fails (a blip at a cold start) is forgotten once it settles, so the next request opens again rather than every
// request failing until the container is recycled. Requests during one open share it.

export function openOnce<T>(open: () => Promise<T>): () => Promise<T> {
  let opening: Promise<T> | undefined;
  return () =>
    (opening ??= open().catch((e: unknown) => {
      opening = undefined;
      throw e;
    }));
}
