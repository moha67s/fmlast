export function buildQuickChartUrl(title: string, labels: string[], data: number[], color: string = '#5865F2', type: 'bar' | 'line' = 'bar'): string {
    // Reduce label density if too many data points
    const maxLabels = 15;
    let displayLabels = labels;
    if (labels.length > maxLabels) {
        const step = Math.ceil(labels.length / maxLabels);
        displayLabels = labels.map((l, i) => (i % step === 0) ? l : '');
    }

    const chartConfig = {
        type: type,
        data: {
            labels: displayLabels,
            datasets: [{
                label: title,
                data: data,
                backgroundColor: type === 'bar' 
                    ? `${color}cc`
                    : `${color}22`,
                borderColor: color,
                fill: type === 'line',
                borderWidth: type === 'bar' ? 0 : 3,
                pointBackgroundColor: color,
                pointRadius: type === 'line' ? (data.length > 20 ? 0 : 3) : undefined,
                borderRadius: type === 'bar' ? 4 : undefined,
                barPercentage: 0.7,
                categoryPercentage: 0.8
            }]
        },
        options: {
            plugins: {
                legend: { display: false },
                title: { 
                    display: true, 
                    text: title, 
                    color: '#ffffff',
                    font: { size: 14, weight: 'bold' }
                },
                datalabels: { display: false }
            },
            scales: {
                x: {
                    ticks: { 
                        color: '#aaaaaa', 
                        maxRotation: 45,
                        font: { size: 10 }
                    },
                    grid: { display: false }
                },
                y: {
                    ticks: { 
                        color: '#aaaaaa', 
                        beginAtZero: true,
                        font: { size: 10 },
                        precision: 0
                    },
                    grid: { color: 'rgba(255,255,255,0.06)' }
                }
            },
            layout: { padding: { left: 10, right: 20, top: 10, bottom: 10 } }
        }
    };

    return `https://quickchart.io/chart?w=600&h=350&bkg=%23191b1f&c=${encodeURIComponent(JSON.stringify(chartConfig))}`;
}
