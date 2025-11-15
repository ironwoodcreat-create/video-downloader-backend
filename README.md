# Video Downloader Backend API

Backend API for video downloader web application using Node.js and yt-dlp.

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Install yt-dlp

**Linux/Mac:**
```bash
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp
```

**Windows:**
Download from https://github.com/yt-dlp/yt-dlp/releases and add to PATH

### 3. Configure Environment

Copy `.env.example` to `.env` and update:

```env
PORT=3000
ALLOWED_ORIGINS=http://localhost:8080
```

### 4. Run Server

**Development:**
```bash
npm run dev
```

**Production:**
```bash
npm start
```

## API Endpoints

### Health Check
```
GET /api/health
```

### Get Video Info
```
POST /api/video/info
Body: { "url": "https://youtube.com/watch?v=..." }
```

### Download Video
```
POST /api/video/download
Body: {
  "url": "https://youtube.com/watch?v=...",
  "format": "best",
  "quality": "1080p",
  "startTime": "00:01:00",
  "endTime": "00:02:00"
}
```

### Get Formats
```
POST /api/video/formats
Body: { "url": "https://youtube.com/watch?v=..." }
```

## Deployment

### Railway.app (Recommended)

1. Push to GitHub
2. Connect to Railway
3. Auto-deploy

### Render.com

1. Connect GitHub repo
2. Build: `npm install`
3. Start: `npm start`

## Security

- Rate limiting: 100 requests per 15 minutes
- CORS protection
- URL validation
- Error handling

## Support

For issues, check:
- Server logs
- yt-dlp installation
- Environment variables

