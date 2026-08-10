import { describe, expect, it } from 'vitest';
import {
  LETTABOT_PROMPT_BEGIN,
  LETTABOT_PROMPT_END,
  SYSTEM_PROMPT,
  mergeSystemPrompt,
} from './system-prompt.js';

/**
 * Regression tests for the destructive system-prompt sync.
 *
 * Bug: lettabot called `agents.update(id, { system: SYSTEM_PROMPT })`, replacing
 * the agent's entire prompt. An agent with memfs/persona blocks kept filesystem
 * access but lost all `<system/...>` block projections and answered out of
 * character. These tests pin the non-destructive merge behaviour.
 */
describe('mergeSystemPrompt', () => {
  const PERSONA_PROMPT = [
    'You are Hortator, a community moderator with a dry wit.',
    '',
    '<system/persona.md>',
    'Speak plainly. Never use markdown tables.',
    '</system/persona.md>',
  ].join('\n');

  it('preserves an existing persona prompt when appending the managed block', () => {
    const merged = mergeSystemPrompt(PERSONA_PROMPT, 'CHANNEL INSTRUCTIONS');

    expect(merged).not.toBeNull();
    // The agent's own prompt survives verbatim -- this is the actual bug.
    expect(merged).toContain('You are Hortator, a community moderator');
    expect(merged).toContain('<system/persona.md>');
    expect(merged).toContain('Speak plainly. Never use markdown tables.');
    // And lettabot's instructions are present, fenced by sentinels.
    expect(merged).toContain('CHANNEL INSTRUCTIONS');
    expect(merged).toContain(LETTABOT_PROMPT_BEGIN);
    expect(merged).toContain(LETTABOT_PROMPT_END);
  });

  it('never drops memory-block projections (the reported symptom)', () => {
    const withBlocks = [
      '<system/persona.md>persona body</system/persona.md>',
      '<system/human.md>human body</system/human.md>',
      '<memory_filesystem>tree</memory_filesystem>',
    ].join('\n');

    const merged = mergeSystemPrompt(withBlocks, SYSTEM_PROMPT) ?? '';

    for (const tag of [
      '<system/persona.md>',
      '<system/human.md>',
      '<memory_filesystem>',
    ]) {
      expect(merged).toContain(tag);
    }
  });

  it('replaces only the managed region on a re-sync, leaving the persona intact', () => {
    const first = mergeSystemPrompt(PERSONA_PROMPT, 'OLD INSTRUCTIONS') ?? '';
    const second = mergeSystemPrompt(first, 'NEW INSTRUCTIONS') ?? '';

    expect(second).toContain('NEW INSTRUCTIONS');
    expect(second).not.toContain('OLD INSTRUCTIONS');
    expect(second).toContain('You are Hortator, a community moderator');
    // Exactly one managed block -- no duplication across repeated syncs.
    expect(second.split(LETTABOT_PROMPT_BEGIN)).toHaveLength(2);
    expect(second.split(LETTABOT_PROMPT_END)).toHaveLength(2);
  });

  it('is idempotent: returns null when the managed body is unchanged', () => {
    const first = mergeSystemPrompt(PERSONA_PROMPT, 'SAME BODY') ?? '';

    expect(mergeSystemPrompt(first, 'SAME BODY')).toBeNull();
  });

  it('uses the managed block alone when the agent has no prompt', () => {
    for (const empty of [undefined, null, '', '   \n  ']) {
      const merged = mergeSystemPrompt(empty, 'BODY');
      expect(merged).toBe(`${LETTABOT_PROMPT_BEGIN}\nBODY\n${LETTABOT_PROMPT_END}`);
    }
  });

  it('does not append endlessly when synced many times', () => {
    let prompt: string = PERSONA_PROMPT;
    for (let i = 0; i < 5; i++) {
      prompt = mergeSystemPrompt(prompt, `BODY ${i}`) ?? prompt;
    }

    expect(prompt.split(LETTABOT_PROMPT_BEGIN)).toHaveLength(2);
    expect(prompt).toContain('BODY 4');
    expect(prompt).not.toContain('BODY 3');
    expect(prompt).toContain('You are Hortator, a community moderator');
  });
});
