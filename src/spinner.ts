/**
 * spinner — a braille spinner for network waits (verify, doctor). On a real
 * terminal it animates in place; piped/scripted output gets exactly the same
 * static text as before, so nothing that parses cvx output ever sees a frame.
 * Never used on the cd-hook hot path.
 */

import { c, dim } from "./colors";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export type Spinner = { stop(finalLine: string): void };

/**
 * Animate `label` until stop(finalLine) replaces the whole line with
 * `finalLine`. Piped/scripted output prints nothing until stop, then exactly
 * `finalLine` — identical to the pre-spinner output.
 */
export function spin(label: string): Spinner {
  if (!process.stdout.isTTY || process.env.NO_COLOR) {
    return { stop: (finalLine) => console.log(finalLine) };
  }
  let i = 0;
  process.stdout.write("\x1b[?25l"); // hide cursor
  const draw = () => process.stdout.write(`\r${c("36", FRAMES[i++ % FRAMES.length])} ${dim(label)}`);
  draw();
  const timer = setInterval(draw, 80);
  return {
    stop(finalLine) {
      clearInterval(timer);
      process.stdout.write(`\r\x1b[2K\x1b[?25h${finalLine}\n`);
    },
  };
}
