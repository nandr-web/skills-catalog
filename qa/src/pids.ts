// Process ids read from text (a tool's output, a file) before anything signals them. Number('') is 0, and a signal to 0
// reaches the sender's own process group (without job control, whatever started it too); -1 reaches every process the
// sender may signal. So an id from text is used only when it's a whole number above 0.

/** The process id in `text`: a whole number above 0, else undefined. */
export function pidFrom(text: string | undefined): number | undefined {
  const m = /^\s*([0-9]+)\s*$/.exec(text ?? '');
  const pid = m ? Number(m[1]) : 0;
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

/** The first process id of a list, one per line; undefined when the list is empty. */
export const firstPid = (text: string): number | undefined => pidFrom(text.split('\n')[0]);
