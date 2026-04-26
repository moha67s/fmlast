import puppeteer, { Browser, Page } from 'puppeteer';
import * as fs from 'fs';
import * as path from 'path';
import handlebars from 'handlebars';
import { LoggerService } from '../bot/LoggerService';

// Register Handlebars Helpers
handlebars.registerHelper('eq', (a, b) => a === b);
handlebars.registerHelper('ne', (a, b) => a !== b);
handlebars.registerHelper('lt', (a, b) => a < b);
handlebars.registerHelper('gt', (a, b) => a > b);
handlebars.registerHelper('lte', (a, b) => a <= b);
handlebars.registerHelper('gte', (a, b) => a >= b);
handlebars.registerHelper('plus', (a, b) => a + b);
handlebars.registerHelper('minus', (a, b) => a - b);

export class PuppeteerService {
    private static browser: Browser | null = null;
    private static pagePool: Page[] = [];
    private static MAX_POOL_SIZE = 3;
    private static isLaunching = false;

    /**
     * Launch or return the existing browser instance with health checks.
     */
    static async getBrowser() {
        if (this.isLaunching) {
            while (this.isLaunching) await new Promise(r => setTimeout(r, 100));
        }

        if (!this.browser || !this.browser.connected) {
            this.isLaunching = true;
            // Clear stale pool references
            this.pagePool = [];
            try {
                LoggerService.info('Launching optimized headless browser...', 'Puppeteer');
                this.browser = await puppeteer.launch({
                    headless: true,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-accelerated-2d-canvas',
                        '--disable-gpu',
                        '--font-render-hinting=none',
                        '--single-process',
                        '--disable-extensions',
                        '--js-flags=--max-old-space-size=256'
                    ]
                });
                LoggerService.info('Browser launched successfully.', 'Puppeteer');
            } catch (err) {
                LoggerService.error('Failed to launch browser', err, 'Puppeteer');
                throw err;
            } finally {
                this.isLaunching = false;
            }
        }
        return this.browser;
    }

    /**
     * Pre-warm the browser and populate the page pool.
     */
    static async warmUp() {
        const browser = await this.getBrowser();
        LoggerService.info(`Warming up ${this.MAX_POOL_SIZE} pages...`, 'Puppeteer');
        
        for (let i = 0; i < this.MAX_POOL_SIZE; i++) {
            const page = await browser.newPage();
            // Optional: Set default viewport or preload common assets
            await page.setViewport({ width: 1000, height: 1000 });
            this.pagePool.push(page);
        }
        LoggerService.info('Warm-up complete.', 'Puppeteer');
    }

    /**
     * Get a page from the pool or create a new one if pool is empty.
     * Validates that pooled pages are still alive before returning them.
     */
    private static async getPage(): Promise<Page> {
        while (this.pagePool.length > 0) {
            const page = this.pagePool.pop()!;
            // Validate the page is still usable
            try {
                if (!page.isClosed()) {
                    return page;
                }
            } catch {
                // Page is dead, discard and try next
            }
        }
        const browser = await this.getBrowser();
        return await browser.newPage();
    }

    /**
     * Return a page to the pool.
     */
    private static async releasePage(page: Page) {
        try {
            if (page.isClosed()) return;
            if (this.pagePool.length < this.MAX_POOL_SIZE) {
                // Clean up the page by going to about:blank to ensure no state leaks
                await page.goto('about:blank').catch(() => {});
                this.pagePool.push(page);
            } else {
                await page.close().catch(() => {});
            }
        } catch {
            // Page is already dead, just discard
        }
    }

    /**
     * Render an HTML template into a PNG buffer.
     * Auto-retries once on session-closed errors by relaunching the browser.
     */
    static async render(templateName: string, data: any, viewport: { width: number; height: number }): Promise<Buffer> {
        try {
            return await this._renderInternal(templateName, data, viewport);
        } catch (err: any) {
            // If the browser/page crashed, relaunch and retry once
            if (err.message?.includes('Session closed') || err.message?.includes('Target closed') || err.message?.includes('Protocol error')) {
                LoggerService.warn(`Browser session crashed during ${templateName} render. Relaunching...`, 'Puppeteer');
                await this.shutdown();
                return await this._renderInternal(templateName, data, viewport);
            }
            throw err;
        }
    }

    private static async _renderInternal(templateName: string, data: any, viewport: { width: number; height: number }): Promise<Buffer> {
        const startTime = Date.now();
        const page = await this.getPage();

        try {
            await page.setViewport(viewport);

            // 1. Read and compile template
            const templatePath = path.join(process.cwd(), 'src', 'images', 'templates', `${templateName}.html`);
            if (!fs.existsSync(templatePath)) {
                throw new Error(`Template not found: ${templatePath}`);
            }

            const templateSource = fs.readFileSync(templatePath, 'utf-8');
            const template = handlebars.compile(templateSource);
            const html = template(data);

            // 2. Load content
            await page.setContent(html, { waitUntil: 'load', timeout: 30000 });

            // 2.5 Ensure all images are fully loaded (including background images)
            await page.evaluate(async () => {
                const images: Set<string> = new Set();
                
                // 1. <img> tags
                document.querySelectorAll('img').forEach(img => { 
                    if (img.src && !img.src.startsWith('data:')) images.add(img.src); 
                });
                
                // 2. Background images
                document.querySelectorAll('*').forEach(el => {
                    const bg = window.getComputedStyle(el).backgroundImage;
                    if (bg && bg !== 'none') {
                        const urlMatch = bg.match(/url\((['"]?)(.*?)\1\)/);
                        if (urlMatch && urlMatch[2] && !urlMatch[2].startsWith('data:')) {
                            images.add(urlMatch[2]);
                        }
                    }
                });

                const imagePromises = Array.from(images).map(url => {
                    return new Promise((resolve) => {
                        const img = new Image();
                        img.onload = resolve;
                        img.onerror = resolve;
                        img.src = url;
                    });
                });
                
                // Safety timeout: don't wait more than 10s for images
                await Promise.race([
                    Promise.all(imagePromises),
                    new Promise(r => setTimeout(r, 10000))
                ]);
            });

            // 3. Take screenshot
            const buffer = await page.screenshot({
                type: 'webp',
                quality: 100,
                omitBackground: false
            });

            const duration = Date.now() - startTime;
            LoggerService.debug(`Rendered ${templateName} in ${duration}ms`, 'Puppeteer');

            return buffer as Buffer;

        } catch (err) {
            LoggerService.error(`Rendering failed for ${templateName}`, err, 'Puppeteer');
            throw err;
        } finally {
            await this.releasePage(page);
        }
    }

    /**
     * Shutdown the browser instance.
     */
    static async shutdown() {
        if (this.browser) {
            for (const page of this.pagePool) {
                await page.close().catch(() => {});
            }
            this.pagePool = [];
            await this.browser.close();
            this.browser = null;
        }
    }
}
