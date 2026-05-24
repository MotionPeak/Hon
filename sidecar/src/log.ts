// A small structured logger used across the engine's scrape, pension, loans
// and server paths. Designed to make debugging easy:
//
//   17:42:03.214 · [scrape:fibi] start            companyId=hapoalim mode=interactive monthsBack=3 startDate=2026-02-23
//   17:42:03.291 · [scrape:fibi] browser.launch   sandbox=on
//   17:42:03.420 · [scrape:fibi] session.restore  hasSession=true cookieCount=14
//   17:42:03.421 · [scrape:fibi] library.start    defaultTimeout=240000
//   17:42:05.011 · [scrape:fibi] library.progress type=LOGGING_IN message="Logging in…"
//   17:42:17.882 · [scrape:fibi] library.progress type=LOGIN_SUCCESS message="Logged in — fetching transactions…"
//   17:42:24.108 · [scrape:fibi] normalize        account=12345-67 txns=42 holdings=0 balance=15203.40 currency=ILS
//   17:42:24.109 · [scrape:fibi] success          elapsedMs=20970 accounts=2 transactions=87 loans=1
//
// Every line goes to STDERR so the JSON event protocol on STDOUT (used by
// the launcher / parent process to track readiness, port and PID) stays
// clean and machine-parseable.
//
// Levels: info/warn/error are always printed; debug is gated on the
// HON_LOG_DEBUG=1 env var so noisy traces don't drown out the signal in
// normal use.

type LogLevel = 'info' | 'warn' | 'error' | 'debug';
type LogFields = Record<string, unknown>;

const LEVEL_SYMBOL: Record<LogLevel, string> = {
  info: '·',
  warn: '⚠',
  error: '✖',
  debug: '∙',
};

// HH:MM:SS.mmm — date-less because runs are short and the timestamp is for
// reading sequence and elapsed time in a single log file, not correlating
// across days. (Use journalctl / a log shipper if you need a full date.)
function fmtTime(): string {
  return new Date().toISOString().slice(11, 23);
}

// Render structured fields as space-separated key=value pairs. Strings with
// whitespace / commas / equals are JSON-quoted so the line stays
// grep-friendly. Long values are truncated to 240 chars so a stray HTML dump
// or stack trace doesn't blow up a terminal.
function fmtFields(fields?: LogFields): string {
  if (!fields) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    let s: string;
    if (v === null) s = 'null';
    else if (typeof v === 'string') s = /[\s=,"]/.test(v) ? JSON.stringify(v) : v;
    else if (typeof v === 'number' || typeof v === 'boolean') s = String(v);
    else if (v instanceof Error) s = JSON.stringify(v.message);
    else {
      try { s = JSON.stringify(v); } catch { s = String(v); }
    }
    if (s.length > 240) s = s.slice(0, 237) + '…';
    parts.push(`${k}=${s}`);
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}

// Pads the "message" column so structured fields line up vertically across
// nearby log lines — much easier to scan than ragged-edge output.
const MESSAGE_WIDTH = 16;
function fmtMessage(message: string): string {
  return message.length >= MESSAGE_WIDTH
    ? message
    : message + ' '.repeat(MESSAGE_WIDTH - message.length);
}

export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  /**
   * Times a phase. Logs "<phase> started" immediately and returns a closure
   * that, when called, logs "<phase> finished" with elapsedMs (plus any
   * extra fields supplied at that point — e.g. result counts).
   *
   *   const done = log.timer('login');
   *   ...login flow...
   *   done({ result: 'success' });
   */
  timer(phase: string, fields?: LogFields): (fields?: LogFields) => void;
  /** Returns a sub-logger whose tag is "<this tag>:<subTag>" — used to scope
   *  context as a flow drills into sub-operations (scrape → loans → fibi). */
  child(subTag: string): Logger;
  /** The tag this logger was created with, for downstream code that wants
   *  to mention it in messages forwarded elsewhere. */
  readonly tag: string;
}

const DEBUG_ENABLED = process.env.HON_LOG_DEBUG === '1';

export function makeLog(tag: string): Logger {
  const emit = (level: LogLevel, message: string, fields?: LogFields): void => {
    if (level === 'debug' && !DEBUG_ENABLED) return;
    const line = `${fmtTime()} ${LEVEL_SYMBOL[level]} [${tag}] ${fmtMessage(message)}${fmtFields(fields)}\n`;
    process.stderr.write(line);
  };
  return {
    tag,
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    debug: (m, f) => emit('debug', m, f),
    timer: (phase, startFields) => {
      const start = Date.now();
      emit('info', `${phase}.start`, startFields);
      return (endFields) => {
        const elapsedMs = Date.now() - start;
        emit('info', `${phase}.end`, { elapsedMs, ...endFields });
      };
    },
    child: (subTag) => makeLog(`${tag}:${subTag}`),
  };
}

/** A no-op logger, useful for unit tests that need to pass *something*
 *  but don't want the noise. */
export const noopLog: Logger = {
  tag: 'noop',
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  timer: () => () => {},
  child: () => noopLog,
};
