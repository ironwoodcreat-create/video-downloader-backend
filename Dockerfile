# Use Node.js 18 base image
FROM node:18

# Install Python3-full and pipx (required for yt-dlp)
# python3-full includes all Python packages needed
RUN apt-get update && \
    apt-get install -y python3-full python3-pip python3-venv && \
    rm -rf /var/lib/apt/lists/*

# Install yt-dlp using pipx (recommended for system-wide tools)
# If pipx not available, use pip with --break-system-packages flag
RUN python3 -m pip install --upgrade pip --break-system-packages && \
    python3 -m pip install yt-dlp --break-system-packages

# Verify yt-dlp installation
RUN yt-dlp --version

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node.js dependencies
RUN npm install

# Copy application files
COPY . .

# Expose port (Railway will set PORT env var)
EXPOSE 8080

# Start the application
CMD ["npm", "start"]

