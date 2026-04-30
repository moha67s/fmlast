export function getBillboardLine(rank: number, previousRank: number | null, name: string, subtext: string, playcount: number, url?: string): string {
    let arrow = '▬';
    let deltaText = '';

    if (previousRank !== null) {
        if (rank < previousRank) {
            arrow = '▲';
            const diff = previousRank - rank;
            deltaText = ` \`(+${diff})\``;
        } else if (rank > previousRank) {
            arrow = '▼';
            const diff = rank - previousRank;
            deltaText = ` \`(-${diff})\``;
        } else {
            arrow = '▬';
        }
    }

    const nameStr = url ? `**[${name}](${url})**` : `**${name}**`;
    const plays = playcount.toLocaleString();

    return `\`${rank}.\` \`${arrow}\`${deltaText} ${nameStr}${subtext ? ` by **${subtext}**` : ''} - **${plays}**`;
}
