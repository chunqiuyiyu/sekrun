import process from 'node:process';
import { readLine, Suggester } from './line_editor.js';
import { formatDuration } from './timer.js';
import { formatToolUsageStats } from './agent.js';
import { confirmDefaultYes } from './approve.js';

export async function runRepl(agent, opts = {}) {
  const versionSuffix = opts.version ? ` v${opts.version}` : '';
  console.error(`sekrun${versionSuffix} - coding agent (DeepSeek V4 Flash)
Project: ${agent.workspaceRoot()}
Type a task, /ask for read-only Q&A, or /help /exit
`);

  let askMode = false;
  const suggester = new Suggester();

  try {
    while (true) {
      const prompt = askMode ? 'ask> ' : '> ';
      const line = await readLine(prompt, {
        workspaceRoot: agent.workspaceRoot(),
        suggester,
      });

      // Ctrl+C / Ctrl+D — exit
      if (line === '') break;

      const trimmed = line.trim();
      if (trimmed.length === 0) continue;

      if (trimmed === '/exit' || trimmed === '/quit') break;
      if (trimmed === '/help') {
        printHelp();
        continue;
      }
      if (trimmed === '/stats') {
        printStats(agent);
        continue;
      }
      if (trimmed === '/ask') {
        askMode = true;
        console.error('(read-only ask mode - /agent to switch back)');
        continue;
      }
      if (trimmed === '/agent') {
        askMode = false;
        console.error('(agent mode)');
        continue;
      }
      if (trimmed === '/caveman') {
        const wasCaveman = agent.config.caveman;
        const { CAVEMAN_PROMPT, FULL_PROMPT } = await import('./agent.js');
        agent.config.caveman = !wasCaveman;
        agent.messages[0] = {
          role: 'system',
          content: agent.config.caveman ? CAVEMAN_PROMPT : FULL_PROMPT,
        };
        console.error(`(caveman mode ${agent.config.caveman ? 'ON' : 'OFF'})`);
        continue;
      }
      if (trimmed.startsWith('/ask ')) {
        const question = trimmed.slice('/ask '.length).trim();
        if (question.length === 0) {
          console.error('Usage: /ask <question>');
          continue;
        }
        await runWithStepContinuation(agent, () => agent.handleUserMessage(question, true), true);
        continue;
      }

      await runWithStepContinuation(agent, () => agent.handleUserMessage(trimmed, askMode), askMode);
    }
  } catch (error) {
    if (error?.name === 'AbortError') {
      // Ctrl+D or signal
    } else {
      throw error;
    }
  }
}

export async function runWithStepContinuation(agent, fn, askMode) {
  const cycleLimit = 10;
  for (let cycle = 1; cycle <= cycleLimit; cycle += 1) {
    const result = await fn();
    const { status, stats } = result;
    if (status === 'finished') {
      if (stats && stats.usage) {
        const u = stats.usage;
        const cacheTotal = u.prompt_cache_hit_tokens + u.prompt_cache_miss_tokens;
        const hitRate = cacheTotal > 0 ? (u.prompt_cache_hit_tokens * 100) / cacheTotal : 0;
        console.error(`\x1b[2m-- step: tokens=${u.total_tokens} (output=${u.completion_tokens}), cache hit rate=${hitRate.toFixed(1)}% --\x1b[22m`);
      }
      return result;
    }
    if (status === 'need_more_steps') {
      if (stats && stats.usage) {
        const u = stats.usage;
        const cacheTotal = u.prompt_cache_hit_tokens + u.prompt_cache_miss_tokens;
        const hitRate = cacheTotal > 0 ? (u.prompt_cache_hit_tokens * 100) / cacheTotal : 0;
        console.error(`\x1b[2m-- step: tokens=${u.total_tokens} (output=${u.completion_tokens}), cache hit rate=${hitRate.toFixed(1)}% --\x1b[22m`);
      }
      if (cycle >= cycleLimit) {
        await confirmDefaultYes('Continue?', async () => {
          // already reached limit
        });
      }
      continue;
    }
    if (status === 'awaiting_confirmation') {
      const confirmed = await confirmDefaultYes(result.confirmationText, async () => {
        // empty
      });
      if (confirmed) {
        agent.pendingConfirmation = true;
      } else {
        agent.pendingConfirmation = false;
      }
      continue;
    }
    return result;
  }

  return await fn();
}

function printHelp() {
  console.error(`Commands:
  /exit, /quit    Exit
  /help           Show this help
  /stats          Show token usage stats
  /ask            Enter read-only ask mode (agent doesn't edit files)
  /agent          Switch back to agent mode
  /caveman        Toggle caveman-style prompting on/off
  /ask <q>        Ask one question in read-only mode
  <task>          Describe what you want the agent to do

Line editing:
  \ + Enter    Continue on next line (backslash continuation)
  Alt+Enter    Insert newline at cursor
  Shift+Enter  Insert newline (CSI-u terminals)
  Tab          Complete command / file path (press twice for list)
  @            Trigger file path completion (press Tab to complete)
  Up/Down      History navigation
  Ctrl+F / →   Accept suggestion character
  Ctrl+E / End Accept full suggestion
  Ctrl+A / Home Go to line start
  Ctrl+U       Delete whole line
  Ctrl+W       Delete word before cursor
  Ctrl+K       Delete after cursor

Step limit:
  Enter        Continue another max-steps chunk when prompted
`);
}

function printStats(agent) {
  const u = agent.stats.usage;
  const cacheTotal = u.prompt_cache_hit_tokens + u.prompt_cache_miss_tokens;
  const hitRate = cacheTotal > 0 ? (u.prompt_cache_hit_tokens * 100) / cacheTotal : 0;
  const outputTokens = u.completion_tokens;
  const total = u.total_tokens;
  console.error(`\x1b[2m-- session end: tokens=${total} (output=${outputTokens}), cache hit rate=${hitRate.toFixed(1)}% --\x1b[22m`);
}
