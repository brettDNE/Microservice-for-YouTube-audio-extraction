import express from 'express';
import cors from 'cors';
import ytdl from 'youtube-dl-exec';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(cors());
app.use(express.json());

app.post('/extract-audio', async (req, res) => {
  try {
    const { videoId } = req.body;
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const outputDir = './downloads';
    
    // Ensure download directory exists
    if (!fs.existsSync(outputDir)){
      fs.mkdirSync(outputDir);
    }

    const videoFilePath = path.join(outputDir, `${videoId}.mp4`);
    const audioFilePath = path.join(outputDir, `${videoId}.mp3`);

    // Download video
    await ytdl(url, {
      output: videoFilePath,
      format: 'bestaudio'
    });

    // Convert to MP3
    await new Promise((resolve, reject) => {
      ffmpeg(videoFilePath)
        .toFormat('mp3')
        .on('end', () => {
          // Delete original video file
          fs.unlinkSync(videoFilePath);
          resolve();
        })
        .on('error', (err) => reject(err))
        .save(audioFilePath);
    });

    // Return audio file details
    res.json({
      audioUrl: `/downloads/${path.basename(audioFilePath)}`,
      videoId: videoId
    });

  } catch (error) {
    console.error('Audio extraction error:', error);
    res.status(500).json({ 
      error: 'Audio extraction failed', 
      details: error.message 
    });
  }
});

// Serve downloaded files
app.use('/downloads', express.static('downloads'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Audio extraction service running on port ${PORT}`);
});
