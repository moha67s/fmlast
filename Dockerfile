FROM node:22-slim

# Install system dependencies for Chrome, FFmpeg, and Slskd/Supervisor
RUN apt-get update \
    && apt-get install -y wget gnupg supervisor curl ca-certificates unzip libicu-dev libssl-dev \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/googlechrome-linux-keyring.gpg \
    && sh -c 'echo "deb [arch=amd64 signed-by=/usr/share/keyrings/googlechrome-linux-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 ffmpeg \
      --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Install slskd (Auto-detect latest ZIP and extract)
RUN SLSKD_VERSION=$(curl -fsSL https://api.github.com/repos/slskd/slskd/releases/latest \
        | grep '"tag_name"' | cut -d'"' -f4) \
    && curl -fsSL "https://github.com/slskd/slskd/releases/download/${SLSKD_VERSION}/slskd-${SLSKD_VERSION}-linux-x64.zip" \
        -o /tmp/slskd.zip \
    && unzip -j /tmp/slskd.zip 'slskd' -d /usr/local/bin/ \
    && chmod +x /usr/local/bin/slskd \
    && rm /tmp/slskd.zip

# Set up working directory
WORKDIR /usr/src/app

# Tell Puppeteer to use the system Chrome
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code and Prisma schema
COPY . .

# Generate Prisma Client
RUN npx prisma generate

# Create necessary directories and copy config
RUN mkdir -p /downloads /tmp/slskd-incomplete /usr/src/app/slskd-data
COPY slskd.yml /usr/src/app/slskd-data/slskd.yml

# Supervisord config
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

EXPOSE 3000 5030

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
