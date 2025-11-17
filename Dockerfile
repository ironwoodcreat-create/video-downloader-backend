# Use Node.js 18 base image
FROM node:18

# Install Python3-full, pipx, and ffmpeg (required for yt-dlp audio/video merging)
# python3-full includes all Python packages needed
# ffmpeg is required for merging video and audio streams AND for --download-sections
RUN apt-get update && \
    apt-get install -y python3-full python3-pip python3-venv ffmpeg && \
    rm -rf /var/lib/apt/lists/* && \
    echo "Verifying ffmpeg installation..." && \
    ffmpeg -version | head -n 1

# Install yt-dlp using pipx (recommended for system-wide tools)
# If pipx not available, use pip with --break-system-packages flag
RUN python3 -m pip install --upgrade pip --break-system-packages && \
    python3 -m pip install yt-dlp --break-system-packages

# Verify yt-dlp and ffmpeg installation
RUN yt-dlp --version && \
    ffmpeg -version && \
    echo "✅ yt-dlp and ffmpeg installed successfully"

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

