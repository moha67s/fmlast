import { BaseCommand } from '../../structures/BaseCommand';
import { prisma } from '../../database/client';
import { SlashCommandBuilder } from 'discord.js';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { SettingService } from '../../services/bot/SettingService';
import { OpenAiService } from '../../services/external/OpenAiService';
import { resolveTargetUser } from '../../utils/userResolver';
import { triggerDeltaSync } from '../../services/bot/QueueWorker';

export default class JudgeCommand extends BaseCommand {
    name = 'judge';
    description = 'Let the AI ruthlessly roast your music taste';
    aliases = ['roast'];

    slashData = new SlashCommandBuilder()
        .setName('judge')
        .setDescription('Let the AI ruthlessly roast your music taste')
        .addUserOption(opt => 
            opt.setName('user')
                .setDescription('User to judge')
                .setRequired(false)
        );

    async execute(interactionOrMessage: any, isSlash = false, args?: string[]): Promise<void> {
        const authorId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;
        const authorDb = await prisma.user.findUnique({ where: { discordId: authorId } });
        const embedColor = authorDb ? SettingService.resolveAccentColor(authorDb) : 0x0a0a0b;

        let targetUserObj = null;

        if (isSlash) {
            targetUserObj = interactionOrMessage.options.getUser('user');
        } else {
            if (args && args.length > 0) {
                const mentionMatch = args[0].match(/<@!?(\d+)>/);
                if (mentionMatch) {
                    try {
                        targetUserObj = await interactionOrMessage.client.users.fetch(mentionMatch[1]);
                    } catch { }
                }
            }
        }

        const author = isSlash ? interactionOrMessage.user : interactionOrMessage.author;
        const lookupUser = targetUserObj || author;
        
        const dbAuthor = await prisma.user.findUnique({ where: { discordId: author.id } });
        if (!dbAuthor) {
            const payload = new ComponentsV2().setAccent(0xff0000).addText('❌ Link your Last.fm first!').build();
            return isSlash ? interactionOrMessage.reply(payload) : interactionOrMessage.reply(payload);
        }

        const userSettings = await SettingService.getUser(lookupUser.id !== author.id ? `<@${lookupUser.id}>` : '', dbAuthor);
        const targetDbUser = userSettings.targetUser;

        if (isSlash && !interactionOrMessage.deferred) await interactionOrMessage.deferReply();
        else if (!isSlash) await interactionOrMessage.channel.sendTyping();

        try {
            // Fire & Forget background sync
            triggerDeltaSync(targetDbUser.discordId);

            // Fetch top artists and tracks
            const [artists, tracks] = await Promise.all([
                prisma.userArtist.findMany({
                    where: { userId: targetDbUser.id },
                    orderBy: { playcount: 'desc' },
                    take: 15
                }),
                prisma.userTrack.findMany({
                    where: { userId: targetDbUser.id },
                    orderBy: { playcount: 'desc' },
                    take: 15
                })
            ]);

            if (artists.length === 0 && tracks.length === 0) {
                const payload = new ComponentsV2().setAccent(0xff0000).addText(`❌ **${userSettings.displayName}** doesn't have enough data to judge yet.`).build();
                if (isSlash) await interactionOrMessage.editReply(payload);
                else await interactionOrMessage.channel.send(payload);
                return;
            }

            const topArtists = artists.map(a => a.artistName);
            const topTracks = tracks.map(t => `${t.trackName} by ${t.artistName}`);

            const aiService = OpenAiService.getInstance();
            const roast = await aiService.generateDetailedPersona(topArtists, topTracks, 'all-time');

            const builder = new ComponentsV2()
                .setAccent(embedColor)
                .addText(`### The AI Judge has spoken for ${userSettings.displayName}\n\n${roast}`);

            const payload = builder.build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.channel.send(payload);

        } catch (err: any) {
            console.error(err);
            const payload = new ComponentsV2().setAccent(0xff0000).addText(`❌ The AI refused to judge: ${err.message}`).build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.channel.send(payload);
        }
    }
}
