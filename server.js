const express = require('express');
const cors = require('cors');
const { spawn, exec } = require('child_process');
const { promisify } = require('util');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const execPromise = promisify(exec);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  credentials: true
}));
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // 100 requests per 15 minutes
});
app.use('/api/', limiter);

// yt-dlp path (Railway will install it via nixpacks or we'll use system yt-dlp)
const ytdlpPath = process.env.YTDLP_PATH || 'yt-dlp';

// Helper function to run yt-dlp command
function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const process = spawn(ytdlpPath, args);
    let stdout = '';
    let stderr = '';

    process.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    process.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    process.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr || `Process exited with code ${code}`));
      }
    });

    process.on('error', (error) => {
      reject(error);
    });
  });
}

// Health check
app.get('/api/health', async (req, res) => {
  try {
    // Check if yt-dlp is available
    await execPromise(`${ytdlpPath} --version`);
    res.json({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      ytdlp: ytdlpPath
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'error',
      message: 'yt-dlp not found. Please install yt-dlp on the server.',
      error: error.message
    });
  }
});

// Get video info
app.post('/api/video/info', async (req, res) => {
  try {
    const { url } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    // Validate URL
    try {
      new URL(url);
    } catch {
      return res.status(400).json({ error: 'Invalid URL format' });
    }

    const result = await runYtDlp([
      '--dump-json',
      '--no-warnings',
      '--no-playlist',
      url
    ]);
    
    const videoInfo = JSON.parse(result);
    
    res.json({
      success: true,
      data: videoInfo
    });
  } catch (error) {
    console.error('Error getting video info:', error);
    res.status(500).json({ 
      error: 'Failed to get video info',
      message: error.message 
    });
  }
});

// Download video (streaming)
app.post('/api/video/download', async (req, res) => {
  try {
    const { url, format, quality, startTime, endTime } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    // Build format string
    let formatSelector = format || 'best';
    if (quality && !format) {
      // Convert quality to format (e.g., "1080p" -> "bestvideo[height<=1080]+bestaudio/best")
      const height = quality.replace('p', '');
      formatSelector = `bestvideo[height<=${height}]+bestaudio/best`;
    }
    
    // Download options
    const args = [
      '--format', formatSelector,
      '--no-playlist',
      '--no-warnings',
      '--no-part',
      '--buffer-size', '128K',
      '--concurrent-fragments', '8',
      '-o', '-', // Output to stdout
    ];
    
    // Time range for clips
    if (startTime || endTime) {
      const start = startTime || '00:00:00';
      const end = endTime || '';
      args.push('--download-sections', `*${start}-${end}`);
      args.push('--force-keyframes-at-cuts');
    }
    
    args.push(url);
    
    // Set headers for streaming
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment');
    res.setHeader('Cache-Control', 'no-cache');
    
    // Stream download
    const ytdlpProcess = spawn(ytdlpPath, args);
    
    ytdlpProcess.stdout.pipe(res);
    
    ytdlpProcess.stderr.on('data', (data) => {
      console.error('yt-dlp stderr:', data.toString());
    });
    
    ytdlpProcess.on('error', (error) => {
      console.error('Process error:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Download failed', message: error.message });
      }
    });
    
    ytdlpProcess.on('close', (code) => {
      if (code !== 0 && !res.headersSent) {
        res.status(500).json({ error: 'Download failed', message: `Process exited with code ${code}` });
      }
    });
    
    // Handle client disconnect
    req.on('close', () => {
      ytdlpProcess.kill();
    });
    
  } catch (error) {
    console.error('Download error:', error);
    if (!res.headersSent) {
      res.status(500).json({ 
        error: 'Download failed',
        message: error.message 
      });
    }
  }
});

// Get available formats
app.post('/api/video/formats', async (req, res) => {
  try {
    const { url } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    const result = await runYtDlp([
      url,
      '--list-formats',
      '--no-warnings'
    ]);
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Error getting formats:', error);
    res.status(500).json({ 
      error: 'Failed to get formats',
      message: error.message 
    });
  }
});

// Download preview video at 360p for clip selection
app.post('/api/video/preview', async (req, res) => {
  try {
    const { url } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    // Download at 360p for preview (smaller file size, faster)
    const args = [
      '--format', 'bestvideo[height<=360]+bestaudio/best[height<=360]',
      '--no-playlist',
      '--no-warnings',
      '--no-part',
      '--buffer-size', '64K',
      '--concurrent-fragments', '4',
      '-o', '-', // Output to stdout
      url
    ];
    
    // Set headers for streaming
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
    
    // Stream download
    const ytdlpProcess = spawn(ytdlpPath, args);
    
    ytdlpProcess.stdout.pipe(res);
    
    ytdlpProcess.stderr.on('data', (data) => {
      console.error('yt-dlp stderr:', data.toString());
    });
    
    ytdlpProcess.on('error', (error) => {
      console.error('Process error:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Preview download failed', message: error.message });
      }
    });
    
    ytdlpProcess.on('close', (code) => {
      if (code !== 0 && !res.headersSent) {
        res.status(500).json({ error: 'Preview download failed', message: `Process exited with code ${code}` });
      }
    });
    
    // Handle client disconnect
    req.on('close', () => {
      ytdlpProcess.kill();
    });
    
  } catch (error) {
    console.error('Preview download error:', error);
    if (!res.headersSent) {
      res.status(500).json({ 
        error: 'Preview download failed',
        message: error.message 
      });
    }
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Video Downloader API running on port ${PORT}`);
  console.log(`📡 Health check: http://localhost:${PORT}/api/health`);
});
