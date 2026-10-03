// Command builders for each supported engine.
//
// Both engines run in non-interactive ("headless") mode with approvals
// bypassed, because tasks run unattended. This is deliberately permissive —
// see docs/02-architecture.md "Security".
//
// Cross-platform note: the task prompt is delivered via STDIN, never as a CLI
// argument. This keeps arbitrary prompt text out of the shell entirely, which
// matters on Windows where npm-installed CLIs are `.cmd` shims that Node can
// only launch with `shell: true` (Node ≥18.20). With the prompt on stdin, the
// only things passed through the shell are fixed, trusted flags. See runner.js.

// Injected (as a system prompt for claude, or prepended to the prompt for codex)
// when a task requests a concise answer.
export const CONCISE_INSTRUCTION =
  '只输出最终答案本身,越短越好,通常就是一个词、一个数字或一句话。' +
  '严禁输出任何解释、推理、步骤、过程数据、中间结果、代码、列表或多余文字。' +
  '例如问某个数值,就只回答那个数值本身。';

export const ENGINES = {
  claude: {
    label: 'Claude Code',
    bin: 'claude',
    promptVia: 'stdin',
    // Concise is injected via stdin (not --append-system-prompt) so that every
    // CLI argument stays pure ASCII — safe under Windows shell:true, where a
    // non-ASCII argv token can be mangled by the console code page.
    stdinText(task) {
      return (task && task.concise ? CONCISE_INSTRUCTION + '\n\n' : '') + task.prompt;
    },
    build() {
      return ['-p', '--output-format', 'json', '--dangerously-skip-permissions'];
    },
    // Claude with --output-format json prints a JSON envelope; the human-facing
    // answer is in `.result`. Fall back to raw stdout if parsing fails.
    parse(stdout) {
      try {
        const obj = JSON.parse(stdout);
        if (obj && typeof obj.result === 'string') return obj.result;
      } catch {
        /* not JSON, use raw */
      }
      return stdout;
    },
    stream: {
      build() {
        return ['-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
      },
      // Parse one JSONL line from stream-json.
      // Returns { delta?: string, final?: string }.
      //   assistant text parts -> delta (shown live)
      //   result line          -> final (authoritative final output)
      line(raw) {
        const trimmed = raw.trim();
        if (!trimmed) return {};
        let obj;
        try {
          obj = JSON.parse(trimmed);
        } catch {
          return { delta: raw }; // non-JSON, pass through
        }
        if (obj.type === 'assistant' && obj.message?.content) {
          const text = obj.message.content
            .filter((p) => p.type === 'text' && typeof p.text === 'string')
            .map((p) => p.text)
            .join('');
          return text ? { delta: text } : {};
        }
        if (obj.type === 'result' && typeof obj.result === 'string') {
          return { final: obj.result };
        }
        return {};
      },
    },
  },

  codex: {
    label: 'Codex',
    bin: 'codex',
    promptVia: 'stdin',
    // codex has no system-prompt flag, so concise is prepended to the prompt.
    stdinText(task) {
      return (task && task.concise ? CONCISE_INSTRUCTION + '\n\n' : '') + task.prompt;
    },
    build() {
      return ['exec', '--dangerously-bypass-approvals-and-sandbox', '-'];
    },
    parse(stdout) {
      return stdout;
    },
    stream: {
      // codex exec already streams human-readable output to stdout.
      build() {
        return ['exec', '--dangerously-bypass-approvals-and-sandbox', '-'];
      },
      line(raw) {
        return { delta: raw };
      },
    },
  },
};

export function isValidEngine(engine) {
  return Object.prototype.hasOwnProperty.call(ENGINES, engine);
}

export function engineList() {
  return Object.entries(ENGINES).map(([id, e]) => ({ id, label: e.label }));
}
