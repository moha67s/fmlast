export function formatDuration(seconds: number): string {
    if (isNaN(seconds) || seconds < 0) return '0:00';
    
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    
    if (h > 0) {
        return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m}:${s.toString().padStart(2, '0')}`;
}

export function createProgressBar(current: number, total: number, size = 15): string {
    if (total <= 0) return '▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬';
    const progress = Math.min(1, Math.max(0, current / total));
    const filledSize = Math.round(progress * size);
    const emptySize = size - filledSize;
    
    const filledBar = '▬'.repeat(filledSize);
    const emptyBar = '▬'.repeat(emptySize);
    
    // Insert the slider button at the transition point
    const bar = filledBar.slice(0, -1) + '🔘' + emptyBar;
    
    return bar;
}
