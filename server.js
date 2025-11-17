const express = require('express');
const cors = require('cors');
const { spawn, exec } = require('child_process');
const { promisify } = require('util');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
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
// Support both GET (for browser native download) and POST (for compatibility)
app.get('/api/video/download', async (req, res) => {
  try {
    const url = req.query.url;
    const format = req.query.format;
    const quality = req.query.quality;
    const startTime = req.query.startTime;
    const endTime = req.query.endTime;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }
    
    // Validate URL
    try {
      new URL(url);
    } catch {
      return res.status(400).json({ error: 'Invalid URL format' });
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
    
    // Set headers for streaming (respect allowed origins)
    // CRITICAL: CORS headers must be set BEFORE streaming starts
    const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const reqOrigin = req.headers.origin;
    const allowOrigin = allowedOrigins.length ? (allowedOrigins.includes(reqOrigin) ? reqOrigin : allowedOrigins[0]) : '*';
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Disposition');
    
    const filename = req.query.filename || 'video.mp4';
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.setHeader('Cache-Control', 'no-cache');
    // Note: Range requests require special handling; not advertising partial support
    
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

// Handle OPTIONS request for CORS preflight (download endpoint)
app.options('/api/video/download', (req, res) => {
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const reqOrigin = req.headers.origin;
  const allowOrigin = allowedOrigins.length ? (allowedOrigins.includes(reqOrigin) ? reqOrigin : allowedOrigins[0]) : '*';
  res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.setHeader('Access-Control-Max-Age', '86400'); // 24 hours
  res.sendStatus(204);
});

// POST endpoint for compatibility (same functionality)
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
    
    // Set headers for streaming (respect allowed origins)
    const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const reqOrigin = req.headers.origin;
    const allowOrigin = allowedOrigins.length ? (allowedOrigins.includes(reqOrigin) ? reqOrigin : allowedOrigins[0]) : '*';
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Disposition');
    
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment');
    res.setHeader('Cache-Control', 'no-cache');
    // Note: Range requests require special handling; not advertising partial support
    
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

    const raw = await runYtDlp([
      url,
      '--list-formats',
      '--no-warnings'
    ]);

    const lines = raw.split('\n');
    const formats = [];
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('[') || /^(ID|format code)/i.test(t)) continue;
      const parts = t.split(/\s+/);
      if (parts.length >= 3) {
        formats.push({
          format_id: parts[0],
          ext: parts[1],
          resolution: parts[2],
          note: parts.slice(3).join(' ')
        });
      }
    }

    res.json({ success: true, data: formats });
  } catch (error) {
    console.error('Error getting formats:', error);
    res.status(500).json({ 
      error: 'Failed to get formats',
      message: error.message 
    });
  }
});

// Download preview video at 360p for clip selection
// Support both GET (for direct streaming) and POST (for compatibility)

// Handle OPTIONS request for CORS preflight
app.options('/api/video/preview', (req, res) => {
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const reqOrigin = req.headers.origin;
  const allowOrigin = allowedOrigins.length ? (allowedOrigins.includes(reqOrigin) ? reqOrigin : allowedOrigins[0]) : '*';
  res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.setHeader('Access-Control-Max-Age', '86400'); // 24 hours
  res.sendStatus(204);
});

app.get('/api/video/preview', async (req, res) => {
  try {
    const url = req.query.url;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }
    
    // Validate URL
    try {
      new URL(url);
    } catch {
      return res.status(400).json({ error: 'Invalid URL format' });
    }

    // HTTP BYTE-RANGE SUPPORT: Cache-based approach for proper seeking
    // Download video to temp file first, then serve with range request support
    const cacheDir = path.join(os.tmpdir(), 'downlox_preview_cache');
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }

    // Generate cache key from URL
    const cacheKey = crypto.createHash('sha256').update(url).digest('hex');
    const cacheFile = path.join(cacheDir, `${cacheKey}.mp4`);

    // Check if file exists and is recent (within 1 hour)
    let needsDownload = true;
    if (fs.existsSync(cacheFile)) {
      const stats = fs.statSync(cacheFile);
      const age = Date.now() - stats.mtimeMs;
      if (age < 3600000) { // 1 hour cache
        needsDownload = false;
        console.log(`Using cached preview: ${cacheFile}`);
      } else {
        // Delete expired cache
        fs.unlinkSync(cacheFile);
      }
    }

    // Download if needed
    if (needsDownload) {
      console.log(`Downloading preview to cache: ${cacheFile}`);
      const args = [
        '--format', 'best[height<=360]/bestvideo[height<=360]+bestaudio[ext=m4a]/bestvideo[height<=360]+bestaudio/best[height<=360]',
        '--merge-output-format', 'mp4',
        '--postprocessor-args', 'ffmpeg:-c:a aac -b:a 128k',
        '--no-playlist',
        '--no-warnings',
        '-o', cacheFile,
        url
      ];

      await new Promise((resolve, reject) => {
        const process = spawn(ytdlpPath, args);
        let stderr = '';
        
        process.stderr.on('data', (data) => {
          stderr += data.toString();
        });
        
        process.on('close', (code) => {
          if (code === 0 && fs.existsSync(cacheFile)) {
            console.log(`Preview cached successfully: ${cacheFile}`);
            resolve();
          } else {
            reject(new Error(`yt-dlp exited with code ${code}: ${stderr}`));
          }
        });
        
        process.on('error', (error) => {
          reject(error);
        });
      });
    }

    // Serve with HTTP Range Request support
    const stat = fs.statSync(cacheFile);
    const total = stat.size;
    const range = req.headers.range;

    // Set CORS headers
    const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const reqOrigin = req.headers.origin;
    const allowOrigin = allowedOrigins.length ? (allowedOrigins.includes(reqOrigin) ? reqOrigin : allowedOrigins[0]) : '*';
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
    res.setHeader('Accept-Ranges', 'bytes'); // CRITICAL: Advertise range support
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'public, max-age=3600');

    if (range) {
      // Parse range header: "bytes=start-end"
      const match = range.match(/bytes=(\d*)-(\d*)/);
      let start = 0;
      let end = total - 1;

      if (match) {
        if (match[1]) start = parseInt(match[1], 10);
        if (match[2]) end = parseInt(match[2], 10);
      }

      // Validate range
      if (start > end || start >= total) {
        res.status(416).setHeader('Content-Range', `bytes */${total}`).end();
        return;
      }

      // Adjust end if beyond file size
      if (end >= total) end = total - 1;

      const chunkSize = (end - start) + 1;
      
      // Send 206 Partial Content
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
      res.setHeader('Content-Length', chunkSize);

      // Stream the requested range
      const stream = fs.createReadStream(cacheFile, { start, end });
      stream.pipe(res);
      
      stream.on('error', (error) => {
        console.error('Stream error:', error);
        if (!res.headersSent) {
          res.status(500).end();
        }
      });
    } else {
      // No range requested - send full file
      res.setHeader('Content-Length', total);
      const stream = fs.createReadStream(cacheFile);
      stream.pipe(res);
      
      stream.on('error', (error) => {
        console.error('Stream error:', error);
        if (!res.headersSent) {
          res.status(500).end();
        }
      });
    }
    
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

// POST endpoint for compatibility (same functionality)
app.post('/api/video/preview', async (req, res) => {
  try {
    const { url } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    // Download at 360p for preview (smaller file size, faster)
    // CRITICAL FIX: Use 'best' format to ensure audio+video together (not separate streams)
    // Previous format 'bestvideo+bestaudio' could fail to merge if ffmpeg unavailable
    // New format prioritizes single stream with audio, falls back to merged streams
    // Format priority: 1) best[height<=360] (single stream), 2) bestvideo+bestaudio[ext=m4a] (merged with AAC), 3) fallback
    const args = [
      '--format', 'best[height<=360]/bestvideo[height<=360]+bestaudio[ext=m4a]/bestvideo[height<=360]+bestaudio/best[height<=360]',
      '--merge-output-format', 'mp4', // Ensure MP4 output with audio
      '--postprocessor-args', 'ffmpeg:-c:a aac -b:a 128k', // Ensure AAC audio codec for browser compatibility
      '--no-playlist',
      '--no-warnings',
      '--no-part',
      '--buffer-size', '64K',
      '--concurrent-fragments', '4',
      '-o', '-', // Output to stdout
      url
    ];
    
    // Set headers for streaming (respect allowed origins)
    const allowedOrigins2 = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const reqOrigin2 = req.headers.origin;
    const allowOrigin2 = allowedOrigins2.length ? (allowedOrigins2.includes(reqOrigin2) ? reqOrigin2 : allowedOrigins2[0]) : '*';
    res.setHeader('Access-Control-Allow-Origin', allowOrigin2);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range');
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

app.options('/api/video/preview_file', (req, res) => {
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const reqOrigin = req.headers.origin;
  const allowOrigin = allowedOrigins.length ? (allowedOrigins.includes(reqOrigin) ? reqOrigin : allowedOrigins[0]) : '*';
  res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.sendStatus(204);
});

app.get('/api/video/preview_file', async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }
    try { new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL format' }); }

    const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const reqOrigin = req.headers.origin;
    const allowOrigin = allowedOrigins.length ? (allowedOrigins.includes(reqOrigin) ? reqOrigin : allowedOrigins[0]) : '*';
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range');

    const hash = crypto.createHash('sha1').update(url).digest('hex');
    const cacheDir = path.join(os.tmpdir(), 'downlox_preview_cache');
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
    const filePath = path.join(cacheDir, `${hash}.mp4`);

    if (!fs.existsSync(filePath)) {
      const args = [
        '--format', 'best[height<=360]/bestvideo[height<=360]+bestaudio[ext=m4a]/bestvideo[height<=360]+bestaudio/best[height<=360]',
        '--merge-output-format', 'mp4',
        '--postprocessor-args', 'ffmpeg:-c:a aac -b:a 128k',
        '--no-playlist',
        '--no-warnings',
        '--no-part',
        '--buffer-size', '64K',
        '--concurrent-fragments', '4',
        '-o', filePath,
        url
      ];
      await new Promise((resolve, reject) => {
        const p = spawn(ytdlpPath, args);
        p.stderr.on('data', () => {});
        p.on('error', (e) => reject(e));
        p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Process exited with code ${code}`)));
      });
    }

    const stat = fs.statSync(filePath);
    const total = stat.size;
    const range = req.headers.range;
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'public, max-age=3600');

    if (range) {
      const match = range.match(/bytes=(\d*)-(\d*)/);
      let start = 0;
      let end = total - 1;
      if (match) {
        if (match[1]) start = parseInt(match[1], 10);
        if (match[2]) end = parseInt(match[2], 10);
      }
      if (start > end || start >= total) {
        return res.status(416).setHeader('Content-Range', `bytes */${total}`).end();
      }
      const chunkSize = (end - start) + 1;
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
      res.setHeader('Content-Length', chunkSize);
      const stream = fs.createReadStream(filePath, { start, end });
      stream.pipe(res);
      stream.on('error', (e) => {
        if (!res.headersSent) res.status(500).end();
      });
    } else {
      res.setHeader('Content-Length', total);
      const stream = fs.createReadStream(filePath);
      stream.pipe(res);
      stream.on('error', (e) => {
        if (!res.headersSent) res.status(500).end();
      });
    }
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({ error: 'Preview file streaming failed', message: error.message });
    }
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Video Downloader API running on port ${PORT}`);
  console.log(`📡 Health check: http://localhost:${PORT}/api/health`);
});
