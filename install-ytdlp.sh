#!/bin/bash
# Install yt-dlp script for Railway

echo "Installing yt-dlp..."

# Try different methods to install yt-dlp
if command -v python3 &> /dev/null; then
    echo "Using python3..."
    python3 -m pip install --upgrade pip
    python3 -m pip install yt-dlp
elif command -v python &> /dev/null; then
    echo "Using python..."
    python -m pip install --upgrade pip
    python -m pip install yt-dlp
elif command -v pip3 &> /dev/null; then
    echo "Using pip3..."
    pip3 install --upgrade pip
    pip3 install yt-dlp
elif command -v pip &> /dev/null; then
    echo "Using pip..."
    pip install --upgrade pip
    pip install yt-dlp
else
    echo "ERROR: Python/pip not found. Installing Python..."
    # Try to install Python (this might not work on Railway)
    apt-get update && apt-get install -y python3 python3-pip
    python3 -m pip install yt-dlp
fi

# Verify installation
if command -v yt-dlp &> /dev/null; then
    echo "✓ yt-dlp installed successfully"
    yt-dlp --version
else
    echo "✗ yt-dlp installation failed"
    exit 1
fi

