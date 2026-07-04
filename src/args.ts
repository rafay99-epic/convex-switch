/** Tiny flag parser: `--key value`, `--flag`, and bundled short flags `-qf`. */
export function parseFlags(args: string[]): { _: string[]; [k: string]: any } {
  const out: { _: string[]; [k: string]: any } = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        out[key] = next;
        i++;
      } else out[key] = true;
    } else if (a.startsWith("-") && a.length > 1) {
      for (const ch of a.slice(1)) out[ch] = true;
    } else out._.push(a);
  }
  return out;
}
