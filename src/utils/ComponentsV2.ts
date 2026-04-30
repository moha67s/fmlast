/**
 * Discord Components v2 (Type 17) Builder
 * Provides a clean interface for creating 'Message Accessory' containers (cards).
 */
export class ComponentsV2 {
    private payload: any = {
        type: 17,
        spoiler: false,
        components: []
    };

    private accentColor?: number;

    /** Set the side accent color of the container */
    setAccent(color: number): this {
        this.payload.accent_color = color;
        return this;
    }

    /** Set whether the entire container is a spoiler */
    setSpoiler(spoiler: boolean): this {
        this.payload.spoiler = spoiler;
        return this;
    }

    /** Set the main image for the container (similar to embed.setImage) */
    setImage(url: string, description?: string, spoiler = false): this {
        return this.addFullImage(url, description, spoiler);
    }

    /** Set a thumbnail for the container */
    setThumbnail(url: string): this {
        // Find the first text component (Type 9 with Type 10) or just push a new one
        const last = this.payload.components[this.payload.components.length - 1];
        if (last && last.type === 10) {
            this.payload.components[this.payload.components.length - 1] = {
                type: 9,
                components: [last],
                accessory: { type: 11, media: { url } }
            };
        } else if (last && last.type === 9) {
            last.accessory = { type: 11, media: { url } };
        } else {
            this.payload.components.push({
                type: 9,
                components: [{ type: 10, content: '\u200B' }],
                accessory: { type: 11, media: { url } }
            });
        }
        return this;
    }

    addFullImage(url: string, description?: string, spoiler = false): this {
        const item: any = {
            media: { url },
            spoiler
        };
        if (description && description.length > 0) {
            item.description = description;
        }

        this.payload.components.push({
            type: 12,
            items: [item]
        });
        return this;
    }

    /** Alias for addFullImage */
    addMedia(url: string, description = '', spoiler = false): this {
        return this.addFullImage(url, description, spoiler);
    }

    /** Add a horizontal separator line */
    addSeparator(): this {
        this.payload.components.push({
            type: 14,
            spacing: 1,
            divider: true
        });
        return this;
    }

    /** 
     * Add a small thumbnail (Type 11) to the right of text content
     */
    addThumbnail(url: string, content?: string): this {
        if (content) {
            this.payload.components.push({
                type: 9,
                components: [{ type: 10, content }],
                accessory: {
                    type: 11,
                    media: { url }
                }
            });
        } else {
            // If no content, we use the last text block if available, 
            // or just add it as a new section with empty space
            const last = this.payload.components[this.payload.components.length - 1];
            if (last && last.type === 10) {
                this.payload.components[this.payload.components.length - 1] = {
                    type: 9,
                    components: [last],
                    accessory: { type: 11, media: { url } }
                };
            } else {
                this.payload.components.push({
                    type: 9,
                    components: [{ type: 10, content: '\u200B' }],
                    accessory: { type: 11, media: { url } }
                });
            }
        }
        return this;
    }

    /** Add small dimmed text at the bottom */
    addFooter(text: string): this {
        this.payload.components.push({
            type: 10,
            content: `-# *${text}*`
        });
        return this;
    }

    /** Add a standard text block to the container */
    addText(content: string): this {
        this.payload.components.push({
            type: 10,
            content
        });
        return this;
    }

    /** 
     * Add a section with text and an accessory (button/media)
     * @param content The text to display in the section
     * @param accessory The component object for the accessory (Type 2 button, Type 11 media)
     */
    addAction(content: string, accessory: any): this {
        this.payload.components.push({
            type: 9,
            components: [{
                type: 10,
                content
            }],
            accessory
        });
        return this;
    }

    /** Add a simple link button as an accessory to a section */
    addLinkButton(content: string, label: string, url: string, emoji?: { name: string; id?: string }): this {
        return this.addAction(content, {
            type: 2,
            style: 5, // Link Style
            label,
            url,
            emoji
        });
    }

    /** Add a standard Action Row (Type 1) containing multiple components */
    addRow(components: any[]): this {
        this.payload.components.push({
            type: 1,
            components
        });
        return this;
    }

    /** 
     * Build the final payload compatible with channel.send() or interaction.reply()
     * @param flags Flag 32768 is usually required for stable v2 rendering
     */
    build(flags = 32768): any {
        return {
            components: [this.payload],
            flags
        };
    }
}
