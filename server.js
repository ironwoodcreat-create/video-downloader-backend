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
    const ytdlpVersion = await execPromise(`${ytdlpPath} --version`);
    // Check if ffmpeg is available (required for clip selection)
    let ffmpegVersion = null;
    try {
      const ffmpegOutput = await execPromise('ffmpeg -version');
      ffmpegVersion = ffmpegOutput.stdout.split('\n')[0] || 'installed';
    } catch (ffmpegError) {
      // ffmpeg not found
    }
    
    res.json({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      ytdlp: ytdlpPath,
      ytdlpVersion: ytdlpVersion.stdout.trim(),
      ffmpeg: ffmpegVersion ? 'installed' : 'NOT INSTALLED',
      ffmpegVersion: ffmpegVersion
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

    // Try with bot bypass flags first
    let result;
    try {
      result = await runYtDlp([
        '--dump-json',
        '--no-warnings',
        '--no-playlist',
        '--no-check-formats', // Don't check format availability
        '--extractor-args', 'youtube:player_client=web',
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        '--referer', 'https://www.youtube.com/',
        url
      ]);
    } catch (firstError) {
      // If first attempt fails, try with different extractor args
      console.log('First attempt failed, trying with android client:', firstError.message);
      try {
        result = await runYtDlp([
          '--dump-json',
          '--no-warnings',
          '--no-playlist',
          '--no-check-formats',
          '--extractor-args', 'youtube:player_client=android',
          '--user-agent', 'Mozilla/5.0 (Linux; Android 10; SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
          '--referer', 'https://www.youtube.com/',
          url
        ]);
      } catch (secondError) {
        // If both fail, try without extractor args
        console.log('Second attempt failed, trying without extractor args:', secondError.message);
        result = await runYtDlp([
          '--dump-json',
          '--no-warnings',
          '--no-playlist',
          '--no-check-formats',
          url
        ]);
      }
    }
    
    const videoInfo = JSON.parse(result);
    
    res.json({
      success: true,
      data: videoInfo
    });
  } catch (error) {
    console.error('Error getting video info:', error);
    
    // Provide more specific error messages
    let errorMessage = error.message || 'Unknown error';
    let statusCode = 500;
    
    if (errorMessage.includes('Private video') || errorMessage.includes('Sign in')) {
      errorMessage = 'This video is private or requires sign-in. Please use a public video URL.';
      statusCode = 403;
    } else if (errorMessage.includes('Video unavailable') || errorMessage.includes('not available')) {
      errorMessage = 'Video is unavailable. It may have been deleted or is not accessible.';
      statusCode = 404;
    } else if (errorMessage.includes('format')) {
      errorMessage = 'Video format not available. The video may be restricted or unavailable in your region.';
      statusCode = 400;
    }
    
    res.status(statusCode).json({ 
      error: 'Failed to get video info',
      message: errorMessage 
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
    let args = [
      '--format', formatSelector,
      '--no-playlist',
      '--no-warnings',
      '--no-part',
      '--buffer-size', '128K',
      '--concurrent-fragments', '8',
      '--extractor-args', 'youtube:player_client=web',
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      '--referer', 'https://www.youtube.com/',
      '-o', '-', // Output to stdout
    ];
    
    // Time range for clips
    // IMPORTANT: --download-sections with -o - (stdout) may not work reliably
    // For clip selection, we'll use a temp file approach for better reliability
    const useTempFile = startTime || endTime;
    let tempFilePath = null;
    
    if (useTempFile) {
      const start = startTime ? startTime : '00:00:00';
      const end = endTime ? endTime : '';
      // yt-dlp format: *HH:MM:SS-HH:MM:SS or *HH:MM:SS- (for end of video)
      const section = end ? `*${start}-${end}` : `*${start}-`;
      console.log(`Clip selection (GET): ${start} to ${end || 'end'}, section: ${section}`);
      
      // Create temp file for clip selection
      const tempDir = path.join(os.tmpdir(), 'downlox_clips');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      tempFilePath = path.join(tempDir, `${crypto.randomBytes(16).toString('hex')}.mp4`);
      
      // Change output to temp file instead of stdout
      args = args.filter(arg => arg !== '-o' && arg !== '-');
      args.push('-o', tempFilePath);
      args.push('--download-sections', section);
      args.push('--force-keyframes-at-cuts');
    }
    
    args.push(url);
    
    const filename = req.query.filename || 'video.mp4';
    
    // For clip selection, download to temp file first, then stream
    // IMPORTANT: Don't set response headers until file is ready to avoid browser timeout
    if (useTempFile) {
      console.log(`Starting clip download: ${filename}, URL: ${url}`);
      console.log(`Clip selection mode: Using temp file ${tempFilePath}`);
      console.log(`Full yt-dlp command: ${ytdlpPath} ${args.join(' ')}`);
      
      const ytdlpProcess = spawn(ytdlpPath, args);
      
      let stderrOutput = '';
      
      ytdlpProcess.stderr.on('data', (data) => {
        const errorMsg = data.toString();
        stderrOutput += errorMsg;
        console.error('yt-dlp stderr:', errorMsg);
      });
      
      ytdlpProcess.on('error', (error) => {
        console.error('Process spawn error:', error);
        if (!res.headersSent) {
          // Set CORS headers before sending error
          const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
          const reqOrigin = req.headers.origin;
          const allowOrigin = allowedOrigins.length ? (allowedOrigins.includes(reqOrigin) ? reqOrigin : allowedOrigins[0]) : '*';
          res.setHeader('Access-Control-Allow-Origin', allowOrigin);
          res.status(500).json({ error: 'Download failed', message: error.message });
        }
        // Clean up temp file
        if (tempFilePath && fs.existsSync(tempFilePath)) {
          fs.unlinkSync(tempFilePath);
        }
      });
      
      ytdlpProcess.on('close', async (code) => {
        console.log(`yt-dlp process closed with code ${code}`);
        
        if (code !== 0) {
          if (!res.headersSent) {
            // Set CORS headers before sending error
            const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
            const reqOrigin = req.headers.origin;
            const allowOrigin = allowedOrigins.length ? (allowedOrigins.includes(reqOrigin) ? reqOrigin : allowedOrigins[0]) : '*';
            res.setHeader('Access-Control-Allow-Origin', allowOrigin);
            res.status(500).json({ 
              error: 'Download failed', 
              message: `Process exited with code ${code}. ${stderrOutput.substring(0, 200)}` 
            });
          }
          // Clean up temp file
          if (tempFilePath && fs.existsSync(tempFilePath)) {
            fs.unlinkSync(tempFilePath);
          }
          return;
        }
        
        // Check if temp file exists and has content
        if (!tempFilePath || !fs.existsSync(tempFilePath)) {
          if (!res.headersSent) {
            const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
            const reqOrigin = req.headers.origin;
            const allowOrigin = allowedOrigins.length ? (allowedOrigins.includes(reqOrigin) ? reqOrigin : allowedOrigins[0]) : '*';
            res.setHeader('Access-Control-Allow-Origin', allowOrigin);
            res.status(500).json({ error: 'Download failed', message: 'Clip file not created' });
          }
          return;
        }
        
        const stats = fs.statSync(tempFilePath);
        if (stats.size === 0) {
          if (!res.headersSent) {
            const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
            const reqOrigin = req.headers.origin;
            const allowOrigin = allowedOrigins.length ? (allowedOrigins.includes(reqOrigin) ? reqOrigin : allowedOrigins[0]) : '*';
            res.setHeader('Access-Control-Allow-Origin', allowOrigin);
            res.status(500).json({ error: 'Download failed', message: 'Clip file is empty' });
          }
          fs.unlinkSync(tempFilePath);
          return;
        }
        
        console.log(`Clip downloaded successfully: ${(stats.size / (1024 * 1024)).toFixed(2)} MB`);
        
        // NOW set headers - file is ready to stream
        // CRITICAL: Set headers only when file is ready to avoid browser timeout
        const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
        const reqOrigin = req.headers.origin;
        const allowOrigin = allowedOrigins.length ? (allowedOrigins.includes(reqOrigin) ? reqOrigin : allowedOrigins[0]) : '*';
        res.setHeader('Access-Control-Allow-Origin', allowOrigin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
        res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Disposition');
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
        res.setHeader('Content-Length', stats.size);
        res.setHeader('Cache-Control', 'no-cache');
        
        // Stream the temp file
        try {
          const fileStream = fs.createReadStream(tempFilePath);
          fileStream.pipe(res);
          
          fileStream.on('end', () => {
            // Clean up temp file after streaming
            if (tempFilePath && fs.existsSync(tempFilePath)) {
              fs.unlinkSync(tempFilePath);
              console.log('Temp clip file cleaned up');
            }
          });
          
          fileStream.on('error', (error) => {
            console.error('File stream error:', error);
            // Clean up temp file
            if (tempFilePath && fs.existsSync(tempFilePath)) {
              fs.unlinkSync(tempFilePath);
            }
          });
        } catch (error) {
          console.error('Error streaming clip file:', error);
          // Clean up temp file
          if (tempFilePath && fs.existsSync(tempFilePath)) {
            fs.unlinkSync(tempFilePath);
          }
        }
      });
      
      // Handle client disconnect
      req.on('close', () => {
        console.log('Client disconnected, killing yt-dlp process');
        ytdlpProcess.kill();
        // Clean up temp file
        if (tempFilePath && fs.existsSync(tempFilePath)) {
          fs.unlinkSync(tempFilePath);
        }
      });
      
      return; // Exit early for clip selection
    }
    
    // For full video, set headers immediately and use direct streaming
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
    res.setHeader('Content-Type', 'video/mp4');
    // CRITICAL: Use attachment with proper filename encoding for browser download
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('Cache-Control', 'no-cache');
    // Note: Range requests require special handling; not advertising partial support
    
    // Stream download with proper error handling and logging
    console.log(`Starting download: ${filename}, URL: ${url}`);
    
    // For full video, use direct streaming (existing code)
    const ytdlpProcess = spawn(ytdlpPath, args);
    
    let bytesStreamed = 0;
    let hasError = false;
    
    // Track bytes streamed for debugging
    ytdlpProcess.stdout.on('data', (chunk) => {
      bytesStreamed += chunk.length;
      if (bytesStreamed % (10 * 1024 * 1024) === 0) { // Log every 10MB
        console.log(`Download progress: ${(bytesStreamed / (1024 * 1024)).toFixed(2)} MB streamed`);
      }
    });
    
    // Pipe stdout to response
    ytdlpProcess.stdout.pipe(res);
    
    ytdlpProcess.stderr.on('data', (data) => {
      const errorMsg = data.toString();
      console.error('yt-dlp stderr:', errorMsg);
      // Check for critical errors
      if (errorMsg.includes('ERROR') || errorMsg.includes('ERROR:')) {
        hasError = true;
        if (!res.headersSent) {
          res.status(500).json({ error: 'Download failed', message: errorMsg });
        } else {
          // Headers already sent, can't send error - log it
          console.error('Critical error after headers sent:', errorMsg);
        }
      }
    });
    
    ytdlpProcess.on('error', (error) => {
      console.error('Process spawn error:', error);
      hasError = true;
      if (!res.headersSent) {
        res.status(500).json({ error: 'Download failed', message: error.message });
      }
    });
    
    ytdlpProcess.on('close', (code) => {
      console.log(`yt-dlp process closed with code ${code}, bytes streamed: ${bytesStreamed}`);
      if (code !== 0) {
        hasError = true;
        if (!res.headersSent) {
          res.status(500).json({ 
            error: 'Download failed', 
            message: `Process exited with code ${code}. Bytes streamed: ${bytesStreamed}` 
          });
        } else if (bytesStreamed === 0) {
          // Headers sent but no data - this is the 0 bytes issue
          console.error('CRITICAL: Headers sent but 0 bytes streamed! Process exit code:', code);
        }
      } else if (bytesStreamed === 0) {
        console.error('WARNING: Process exited successfully but 0 bytes streamed!');
      } else {
        console.log(`Download completed successfully: ${(bytesStreamed / (1024 * 1024)).toFixed(2)} MB`);
      }
    });
    
    // Handle client disconnect
    req.on('close', () => {
      console.log('Client disconnected, killing yt-dlp process');
      ytdlpProcess.kill();
    });
    
    // Timeout protection (30 minutes max)
    setTimeout(() => {
      if (!ytdlpProcess.killed) {
        console.error('Download timeout after 30 minutes');
        ytdlpProcess.kill();
        if (!res.headersSent) {
          res.status(500).json({ error: 'Download timeout' });
        }
      }
    }, 30 * 60 * 1000);
    
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
      '--extractor-args', 'youtube:player_client=web',
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      '--referer', 'https://www.youtube.com/',
      '-o', '-', // Output to stdout
    ];
    
    // Time range for clips
    if (startTime || endTime) {
      const start = startTime ? startTime : '00:00:00';
      const end = endTime ? endTime : '';
      // yt-dlp format: *HH:MM:SS-HH:MM:SS or *HH:MM:SS- (for end of video)
      const section = end ? `*${start}-${end}` : `*${start}-`;
      console.log(`Clip selection (POST): ${start} to ${end || 'end'}, section: ${section}`);
      args.push('--download-sections', section);
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
      '--extractor-args', 'youtube:player_client=web',
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      '--referer', 'https://www.youtube.com/',
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
        '--extractor-args', 'youtube:player_client=web',
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        '--referer', 'https://www.youtube.com/',
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
      '--extractor-args', 'youtube:player_client=web',
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      '--referer', 'https://www.youtube.com/',
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
        '--extractor-args', 'youtube:player_client=web',
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        '--referer', 'https://www.youtube.com/',
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
