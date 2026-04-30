export class Paginator {
    static async paginate(
        interactionOrMessage: any,
        isSlash: boolean,
        authorId: string,
        totalPages: number,
        generatePayload: (page: number) => any
    ): Promise<void> {
        let currentPage = 1;

        const initialPayload = generatePayload(currentPage);
        const message = isSlash 
            ? await interactionOrMessage.editReply(initialPayload)
            : await interactionOrMessage.channel.send(initialPayload);

        if (totalPages > 1) {
            const collector = message.createMessageComponentCollector({
                filter: (i: any) => i.user.id === authorId,
                time: 60000
            });

            collector.on('collect', async (i: any) => {
                if (i.customId === 'paginator_prev') currentPage = Math.max(1, currentPage - 1);
                else if (i.customId === 'paginator_next') currentPage = Math.min(totalPages, currentPage + 1);
                await i.update(generatePayload(currentPage));
            });

            collector.on('end', () => {
                // Optionally disable buttons on timeout
            });
        }
    }
}
