import process from 'node:process';
import path from 'node:path';
import { formatDuration, formatTokens } from './timer.js';
import { dispatch, approvalFor, approvalPrompt, isReadOnlyTool } from './tools.js';
import { printBeautified } from './format.js';
import { confirm } from './approve.js';
import { Workspace } from './workspace.js';

const color = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  red: '\x1b[31m',
};

const ansi = {
  step: '\x1b[38;5;75m',
  reset: color.reset,
  bold: color.bold,
  statsDim: '\x1b[2m\x1b[90m',
};

export class Agent {
  static async create(client, config) {
    const workdir = path.resolve(config.workdir || process.cwd());
    const workspace = await Workspace.open(workdir);
    return new Agent(client, workspace, {
      maxOutput: config.maxOutput ?? 8192,
      maxStepsPerTurn: config.maxStepsPerTurn ?? 40,
      verbose: config.verbose ?? false,
    });
  }

  constructor(client, workspace, config) {
    this.client = client;
    this.workspace = workspace;
    this.config = config;
    this.messages = [];
    this.stats = {
      steps: 0,
      toolTime: 0,
      usage: emptyUsage(),
      toolUsage: {},
    };
  }

  workspaceRoot() {
    return this.workspace.root;
  }

  async handleUserMessage(input, askMode) {
    this.messages.push({ role: 'user', content: input });
    const startUsage = { ...this.stats.usage };
    const startToolTime = this.stats.toolTime;

    for (let turnStep = 0; turnStep < this.config.maxStepsPerTurn; turnStep += 1) {
      this.stats.steps += 1;
      const result = await this.client.query(this.messages);

      accumulateUsage(this.stats.usage, result.usage);

      if (result.tool_calls.length === 0) {
        const thinkMs = this.stats.toolTime - startToolTime;
        if (this.config.verbose) {
          console.error(
            `${ansi.step}->${ansi.reset} ${ansi.bold}step ${this.stats.steps}${ansi.reset}: ${formatDuration(thinkMs)} \u00b7 ` +
            `prompt=${formatTokens(result.usage.prompt_tokens)} completion=${formatTokens(result.usage.completion_tokens)}`
          );
        } else {
          const cacheRate = getCacheRate(result.usage);
          console.error(`${ansi.step}->${ansi.reset} ${ansi.bold}step ${this.stats.steps}${ansi.reset} ${formatDuration(thinkMs)}${cacheRate}`);
        }

        printBeautified(result.content);
        this.messages.push({ role: 'assistant', content: result.content });
        break;
      }

      const thinkMs = this.stats.toolTime - startToolTime;
      if (this.config.verbose) {
        console.error(
          `${ansi.step}->${ansi.reset} ${ansi.bold}step ${this.stats.steps}${ansi.reset}: ${formatDuration(thinkMs)} \u00b7 ` +
          `${result.tool_calls.length} tool call(s) · ` +
          `prompt=${formatTokens(result.usage.prompt_tokens)} completion=${formatTokens(result.usage.completion_tokens)}`
        );
      } else {
        const cacheRate = getCacheRate(result.usage);
        console.error(`${ansi.step}->${ansi.reset} ${ansi.bold}step ${this.stats.steps}${ansi.reset} ${formatDuration(thinkMs)}${cacheRate}`);
      }

      this.messages.push({ role: 'assistant', content: result.content, tool_calls: result.tool_calls });

      for (const call of result.tool_calls) {
        const toolMs = await this.runTool(call, askMode);
        this.stats.toolTime += toolMs;
        if (!this.stats.toolUsage[call.name]) {
          this.stats.toolUsage[call.name] = emptyUsage();
        }
        const perToolUsage = { ...result.usage };
        accumulateUsage(this.stats.toolUsage[call.name], perToolUsage);
      }
    }

    const turnSteps = this.stats.steps;
    this.printTurnStats(startUsage, turnSteps);
  }

  async runTool(call, askMode) {
    const isReadOnly = isReadOnlyTool(call.name);
    if (askMode && !isReadOnly) {
      const result = `Blocked: tool '${call.name}' is not allowed in read-only ask mode.`;
      this.messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: result });
      return 0;
    }

    const approval = await approvalFor(this, call.name, call.arguments);
    if (approval === 'on_request') {
      const prompt = approvalPrompt(call.name, call.arguments);
      const ok = await confirm(prompt);
      if (!ok) {
        this.messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: 'User denied this action.' });
        return 0;
      }
    }

    const start = Date.now();
    let result;
    try {
      result = await dispatch(this, call.name, call.arguments);
    } catch (error) {
      result = `Error: ${error?.message || error}`;
    }
    const elapsed = Date.now() - start;

    result = String(result);
    result = this.truncateOutput(result);

    this.messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: result });
    return elapsed;
  }

  truncateOutput(outputStr) {
    if (outputStr.length <= this.config.maxOutput) return outputStr;
    const front = this.config.maxOutput - 500;
    const back = 300;
    return outputStr.slice(0, front) + '\n\n...[truncated]...\n\n' + outputStr.slice(-back);
  }

  printTurnStats(startUsage, turnSteps) {
    const u = this.stats.usage;
    const d = diffUsage(u, startUsage);
    const toolUsageEntries = Object.entries(this.stats.toolUsage).filter(
      ([name, tu]) => tu && (tu.prompt_tokens || tu.completion_tokens),
    );

    const statsLines = [];
    statsLines.push(`${ansi.statsDim}turn steps: ${turnSteps}${ansi.reset}`);
    statsLines.push(`${ansi.statsDim}tools total running time: ${formatDuration(this.stats.toolTime)}${ansi.reset}`);

    if (toolUsageEntries.length > 0) {
      for (const [name, tu] of toolUsageEntries) {
        statsLines.push(
          `${ansi.statsDim}  ${name}: ${tu.prompt_tokens} prompt + ${tu.completion_tokens} completion = ${tu.prompt_tokens + tu.completion_tokens} tokens${ansi.reset}`,
        );
      }
    }

    statsLines.push(
      `${ansi.statsDim}this turn: ${d.prompt_tokens} prompt + ${d.completion_tokens} completion = ${d.prompt_tokens + d.completion_tokens} tokens${ansi.reset}`,
    );
    statsLines.push(
      `${ansi.statsDim}all turns: ${u.prompt_tokens} prompt + ${u.completion_tokens} completion = ${u.prompt_tokens + u.completion_tokens} tokens${ansi.reset}`,
    );

    console.error(statsLines.join(' · '));
  }
}

export function emptyUsage() {
  return {
    prompt_tokens: 0,
    completion_tokens: 0,
    prompt_cache_hit_tokens: 0,
    prompt_cache_miss_tokens: 0,
    total_tokens: 0,
  };
}

export function accumulateUsage(target, source) {
  target.prompt_tokens += source.prompt_tokens ?? 0;
  target.completion_tokens += source.completion_tokens ?? 0;
  target.prompt_cache_hit_tokens += source.prompt_cache_hit_tokens ?? 0;
  target.prompt_cache_miss_tokens += source.prompt_cache_miss_tokens ?? 0;
  target.total_tokens += source.total_tokens ?? 0;
}

function deepCopyToolUsage(toolUsage) {
  const copy = {};
  for (const [name, u] of Object.entries(toolUsage)) {
    copy[name] = { ...u };
  }
  return copy;
}

function diffUsage(current, previous) {
  return {
    prompt_tokens: current.prompt_tokens - (previous.prompt_tokens ?? 0),
    completion_tokens: current.completion_tokens - (previous.completion_tokens ?? 0),
    prompt_cache_hit_tokens: current.prompt_cache_hit_tokens - (previous.prompt_cache_hit_tokens ?? 0),
    prompt_cache_miss_tokens: current.prompt_cache_miss_tokens - (previous.prompt_cache_miss_tokens ?? 0),
    total_tokens: current.total_tokens - (previous.total_tokens ?? 0),
  };
}

function getCacheRate(usage) {
  const cacheTotal = (usage.prompt_cache_hit_tokens ?? 0) + (usage.prompt_cache_miss_tokens ?? 0);
  if (cacheTotal <= 0) return '';
  const rate = (usage.prompt_cache_hit_tokens * 100) / cacheTotal;
  return ` · cache ${rate.toFixed(0)}%`;
}

function getCacheHitPercent(usage) {
  const total = usage.prompt_tokens;
  if (total <= 0) return '0.0';
  return ((usage.prompt_cache_hit_tokens * 100) / total).toFixed(1);
}

export function formatTurnStats(usage, turnSteps) {
  const entries = [
    `-- turn --`,
    `steps ${turnSteps}`,
    `prompt ${usage.prompt_tokens}`,
    `cache_hit ${usage.prompt_cache_hit_tokens} (${getCacheHitPercent(usage)}%)`,
    `cache_miss ${usage.prompt_cache_miss_tokens}`,
    `completion ${usage.completion_tokens}`,
  ];
  return `${ansi.statsDim}${entries.join(' · ')}${ansi.reset}`;
}

export function formatToolUsageStats(toolUsage) {
  const entries = Object.entries(toolUsage).filter(
    ([, tu]) => tu && (tu.prompt_tokens || tu.completion_tokens),
  );
  if (entries.length === 0) return `${ansi.statsDim}(no tool usage recorded)${ansi.reset}`;

  return entries
    .map(([name, tu]) => {
      const cacheTotal = tu.prompt_cache_hit_tokens + tu.prompt_cache_miss_tokens;
      const cacheRate = cacheTotal > 0
        ? `, cache_hit ${tu.prompt_cache_hit_tokens} (${((tu.prompt_cache_hit_tokens * 100) / cacheTotal).toFixed(1)}%)`
        : '';
      return `${ansi.statsDim}${name}: prompt ${tu.prompt_tokens}, completion ${tu.completion_tokens}${cacheRate}${ansi.reset}`;
    })
    .join('\n');
}
