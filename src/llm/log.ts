// One line for each model call, with the time and the result. The server and the commands print the lines.
// The tests do not set a log function, so they print nothing.
let write: ((line: string) => void) | null = null;

export function setModelLog(log: ((line: string) => void) | null): void {
  write = log;
}

export function logModelCall(start: number, result: string): void {
  write?.(`Model call: ${((Date.now() - start) / 1000).toFixed(1)} s, ${result}`);
}
