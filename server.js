const express = require('express');
const cors = require('cors');
const { YTDlpWrap } = require('yt-dlp-wrap');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

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

// yt-dlp path
const ytdlpPath = process.env.YTDLP_PATH || 'yt-dlp';

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    ytdlp: ytdlpPath
  });
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

    const ytDlpWrap = new YTDlpWrap(ytdlpPath);
    
    const videoInfo = await ytDlpWrap.getVideoInfo(url);
    
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

    const ytDlpWrap = new YTDlpWrap(ytdlpPath);
    
    // Build format string
    let formatSelector = format || 'best';
    if (quality && !format) {
      // Convert quality to format (e.g., "1080p" -> "bestvideo[height<=1080]+bestaudio/best")
      const height = quality.replace('p', '');
      formatSelector = `bestvideo[height<=${height}]+bestaudio/best`;
    }
    
    // Download options
    const options = [
      '--format', formatSelector,
      '--no-playlist',
      '--no-warnings',
      '--no-part',
      '--buffer-size', '128K',
      '--concurrent-fragments', '8',
    ];
    
    // Time range for clips
    if (startTime || endTime) {
      const start = startTime || '00:00:00';
      const end = endTime || '';
      options.push('--download-sections', `*${start}-${end}`);
      options.push('--force-keyframes-at-cuts');
    }
    
    // Set headers for streaming
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment');
    res.setHeader('Cache-Control', 'no-cache');
    
    // Stream download
    const stream = ytDlpWrap.execStream([url, ...options]);
    
    stream.on('error', (error) => {
      console.error('Stream error:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Download failed', message: error.message });
      }
    });
    
    stream.pipe(res);
    
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

    const ytDlpWrap = new YTDlpWrap(ytdlpPath);
    
    const formats = await ytDlpWrap.execPromise([
      url,
      '--list-formats',
      '--no-warnings'
    ]);
    
    res.json({
      success: true,
      data: formats
    });
  } catch (error) {
    console.error('Error getting formats:', error);
    res.status(500).json({ 
      error: 'Failed to get formats',
      message: error.message 
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Video Downloader API running on port ${PORT}`);
  console.log(`📡 Health check: http://localhost:${PORT}/api/health`);
});

