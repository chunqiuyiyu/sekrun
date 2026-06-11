import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatTurnStats,
  formatToolUsageStats,
  emptyUsage,
  accumulateUsage,
} from '../lib/agent.js';

test('formatTurnStats dims metadata and preserves usage details', () => {
  const out = formatTurnStats({
    prompt_tokens: 12,
    prompt_cache_hit_tokens: 8,
    prompt_cache_miss_tokens: 2,
    completion_tokens: 4,
  }, 3);

  assert.ok(out.startsWith('\x1b[2m\x1b[90m'));
  assert.ok(out.endsWith('\x1b[0m'));
  assert.match(out, /-- turn --/);
  assert.match(out, /prompt\s+12/);
  assert.match(out, /cache_hit\s+8 \(66\.7%\)/);
  assert.match(out, /cache_miss\s+2/);
  assert.match(out, /completion\s+4/);
  assert.match(out, /steps 3/);
});

test('formatToolUsageStats shows per-tool breakdown', () => {
  const toolUsage = {
    read_file: {
      prompt_tokens: 400,
      completion_tokens: 50,
      prompt_cache_hit_tokens: 300,
      prompt_cache_miss_tokens: 100,
      total_tokens: 450,
    },
    bash: {
      prompt_tokens: 200,
      completion_tokens: 30,
      prompt_cache_hit_tokens: 150,
      prompt_cache_miss_tokens: 50,
      total_tokens: 230,
    },
  };

  const out = formatToolUsageStats(toolUsage);

  assert.match(out, /bash/);
  assert.match(out, /read_file/);
  assert.match(out, /prompt\s+400/);
  assert.match(out, /completion\s+50/);
  assert.match(out, /cache_hit\s+300 \(75\.0%\)/);
  assert.match(out, /prompt\s+200/);
});

test('formatToolUsageStats returns placeholder for empty data', () => {
  const out = formatToolUsageStats({});
  assert.match(out, /no tool usage recorded/);
});

test('accumulateUsage adds values correctly', () => {
  const total = emptyUsage();
  accumulateUsage(total, {
    prompt_tokens: 100,
    completion_tokens: 20,
    prompt_cache_hit_tokens: 60,
    prompt_cache_miss_tokens: 40,
    total_tokens: 120,
  });
  assert.equal(total.prompt_tokens, 100);
  assert.equal(total.completion_tokens, 20);
  assert.equal(total.total_tokens, 120);

  accumulateUsage(total, {
    prompt_tokens: 50,
    completion_tokens: 10,
    total_tokens: 60,
  });
  assert.equal(total.prompt_tokens, 150);
  assert.equal(total.completion_tokens, 30);
  assert.equal(total.total_tokens, 180);
});
