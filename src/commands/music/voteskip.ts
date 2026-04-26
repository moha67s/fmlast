import { BaseCommand } from '../../structures/BaseCommand';
import { MusicPlayer } from '../../services/music/MusicPlayer';
import { QueueManager } from '../../services/music/QueueManager';
import { SlashCommandBuilder, VoiceChannel } from 'discord.js';

const votes = new Map<string, Set<string>>();

export default class VoteSkipCommand extends BaseCommand {
    name = 'voteskip';
    description = 'Vote to skip the current track';

    slashData = new SlashCommandBuilder()
        .setName(this.name)
        .setDescription(this.description);

    async execute(interaction: any) {
        if (!interaction.guildId) return;
        const queue = QueueManager.getQueue(interaction.guildId);
        
        if (!queue?.isPlaying) {
            return interaction.reply({ content: '❌ Nothing is currently playing.', ephemeral: true });
        }

        const member = interaction.member as any;
        const voiceChannel = member.voice.channel as VoiceChannel;
        if (!voiceChannel || voiceChannel.id !== queue.voiceChannelId) {
            return interaction.reply({ content: '❌ You must be in the same voice channel to vote.', ephemeral: true });
        }

        const listeners = voiceChannel.members.filter(m => !m.user.bot).size;
        const required = Math.ceil(listeners / 2);
        
        if (!votes.has(interaction.guildId)) {
            votes.set(interaction.guildId, new Set());
        }

        const guildVotes = votes.get(interaction.guildId)!;
        if (guildVotes.has(interaction.user.id)) {
            return interaction.reply({ content: `⚠️ You have already voted! (${guildVotes.size}/${required})`, ephemeral: true });
        }

        guildVotes.add(interaction.user.id);

        if (guildVotes.size >= required) {
            votes.delete(interaction.guildId);
            MusicPlayer.skip(interaction.guildId);
            await interaction.reply({ content: `⏭️ Vote passed! Skipping... (${guildVotes.size}/${required})` });
        } else {
            await interaction.reply({ content: `✅ Vote added! (${guildVotes.size}/${required} required)` });
        }
    }

    // Reset votes on track start (hooked in MusicPlayer)
    static resetVotes(guildId: string) {
        votes.delete(guildId);
    }
}
