import { describe, expect, it, vi } from 'vitest';
import { handleInteraction } from '../src/discord/interactions';
import { checkInteractionRouting } from '../src/discord/interaction-routing';
import * as repo from '../src/db/repo';
import { freshProject, ALEX } from './helpers';

function setupInteraction(timezone = 'America/Phoenix') {
  const interaction: any = {
    commandName: 'setup', guildId: 'g1', channelId: 'setup-channel', channel: { id: 'setup-channel' },
    user: { id: ALEX, username: 'Alex', globalName: 'Alex' }, member: { displayName: 'Alex' },
    deferred: false, replied: false,
    isAutocomplete: () => false, isChatInputCommand: () => true, isRepliable: () => true,
    options: {
      getString: vi.fn((name: string) => {
        // Date/options work must begin only after the acknowledgement.
        expect(interaction.deferred).toBe(true);
        return ({ timezone, name: 'Setup regression project', deadline: 'November 6, 2030 11:59pm' } as Record<string, string>)[name] ?? null;
      }),
      getAttachment: () => null, getUser: () => null,
    },
    deferReply: vi.fn(async () => { interaction.deferred = true; }),
    editReply: vi.fn(async () => { interaction.replied = true; }),
    reply: vi.fn(), followUp: vi.fn(),
  };
  return interaction;
}

describe('/setup acknowledgement', () => {
  it('acknowledges setup without a rubric before parsing and completes the deferred reply', async () => {
    freshProject();
    const interaction = setupInteraction();
    await handleInteraction({} as any, interaction);
    expect(interaction.deferReply).toHaveBeenCalledOnce();
    expect(interaction.editReply).toHaveBeenCalledOnce();
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.followUp).not.toHaveBeenCalled();
    expect(repo.getProjectByChannel('setup-channel')?.name).toBe('Setup regression project');
    expect(interaction.editReply.mock.calls[0][0].embeds[0].toJSON().title).toContain('is set up');
  });

  it('finishes the deferred reply with an actionable validation error', async () => {
    freshProject();
    const interaction = setupInteraction('Invalid/Timezone');
    await handleInteraction({} as any, interaction);
    expect(interaction.deferReply).toHaveBeenCalledOnce();
    expect(interaction.editReply).toHaveBeenCalledWith({ content: expect.stringContaining('Unknown timezone') });
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.followUp).not.toHaveBeenCalled();
    expect(repo.getProjectByChannel('setup-channel')).toBeUndefined();
  });
});

describe('slash-command delivery', () => {
  it('accepts Gateway delivery', () => {
    expect(() => checkInteractionRouting({ interactionsEndpointURL: null })).not.toThrow();
  });
  it('explains a configured external webhook without exposing its URL', () => {
    const endpoint = 'https://example.invalid/hooks?secret=private';
    expect(() => checkInteractionRouting({ interactionsEndpointURL: endpoint })).toThrow('Clear that URL');
    try { checkInteractionRouting({ interactionsEndpointURL: endpoint }); } catch (error) {
      expect((error as Error).message).not.toContain(endpoint);
    }
  });
});
