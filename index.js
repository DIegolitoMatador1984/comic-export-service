// Railway Export Service for Comic Creator
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const archiver = require('archiver');
const { PDFDocument } = require('pdf-lib');
const sharp = require('sharp');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const exportFiles = new Map();
const exportQueue = [];
let isProcessing = false;

const updateExportStatus = async (exportId, status, data = {}) => {
  try {
    const response = await fetch('https://preview--comicreate-5f5892c3.base44.app/api/apps/69625406b9fddce15f5892c3/functions/updateExportStatus', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ 
        export_id: exportId, 
        status, 
        ...data 
      })
    });
    
    if (!response.ok) {
      console.error('Failed to update status:', await response.text());
    } else {
      console.log('✅ Status updated to:', status);
    }
  } catch (error) {
    console.error('❌ Error updating status:', error);
  }
};

const processQueue = async () => {
  if (isProcessing || exportQueue.length === 0) return;
  
  isProcessing = true;
  const task = exportQueue.shift();
  
  try {
    await task();
  } catch (error) {
    console.error('Queue task failed:', error);
  }
  
  isProcessing = false;
  if (exportQueue.length > 0) processQueue();
};

const downloadImage = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download: ${url}`);
  return Buffer.from(await response.arrayBuffer());
};

const compressImage = async (imageBuffer, quality = 85) => {
  return sharp(imageBuffer)
    .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
    .png({ compression: quality === 98 ? 1 : 6 })
    .toBuffer();
};

const generateCBZ = async (pages, covers, compression = 'compressed') => {
  const compressionLevel = compression === 'fullhd' ? 1 : 9;
  const archive = archiver('zip', { zlib: { level: compressionLevel } });
  const chunks = [];

  archive.on('data', (chunk) => chunks.push(chunk));
  
  return new Promise(async (resolve, reject) => {
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);

    try {
      let fileIndex = 0;

      if (covers.comic_cover) {
        const coverBuffer = await downloadImage(covers.comic_cover);
        archive.append(coverBuffer, { name: `000_cover.png` });
        fileIndex++;
      }

      if (covers.chapter_cover) {
        const chapterCoverBuffer = await downloadImage(covers.chapter_cover);
        archive.append(chapterCoverBuffer, { name: `001_chapter.png` });
        fileIndex++;
      }

      for (const page of pages) {
        if (page.page_number === 0) continue;
        
        console.log(`Downloading page ${page.page_number}...`);
        const imageBuffer = await downloadImage(page.image_url);
        const paddedNumber = String(fileIndex).padStart(3, '0');
        archive.append(imageBuffer, { name: `${paddedNumber}_page_${page.page_number}.png` });
        fileIndex++;
      }

      if (covers.back_cover) {
        const backCoverBuffer = await downloadImage(covers.back_cover);
        archive.append(backCoverBuffer, { name: `${String(fileIndex).padStart(3, '0')}_back.png` });
      }

      archive.finalize();
    } catch (error) {
      reject(error);
    }
  });
};

const generatePDF = async (pages, covers, compression = 'compressed') => {
  const pdfDoc = await PDFDocument.create();
  const quality = compression === 'fullhd' ? 98 : 85;

  if (covers.comic_cover) {
    const coverBuffer = await downloadImage(covers.comic_cover);
    const imageBuffer = await compressImage(coverBuffer, quality);
    const coverImage = await pdfDoc.embedPng(imageBuffer);
    const coverPage = pdfDoc.addPage([coverImage.width, coverImage.height]);
    coverPage.drawImage(coverImage, { x: 0, y: 0, width: coverImage.width, height: coverImage.height });
  }

  if (covers.chapter_cover) {
    const chapterBuffer = await downloadImage(covers.chapter_cover);
    const imageBuffer = await compressImage(chapterBuffer, quality);
    const chapterImage = await pdfDoc.embedPng(imageBuffer);
    const chapterPage = pdfDoc.addPage([chapterImage.width, chapterImage.height]);
    chapterPage.drawImage(chapterImage, { x: 0, y: 0, width: chapterImage.width, height: chapterImage.height });
  }

  for (const page of pages) {
    if (page.page_number === 0) continue;
    
    console.log(`Processing page ${page.page_number}...`);
    const imageBuffer = await downloadImage(page.image_url);
    const finalBuffer = await compressImage(imageBuffer, quality);
    const image = await pdfDoc.embedPng(finalBuffer);
    const pdfPage = pdfDoc.addPage([image.width, image.height]);
    pdfPage.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  }

  if (covers.back_cover) {
    const backBuffer = await downloadImage(covers.back_cover);
    const imageBuffer = await compressImage(backBuffer, quality);
    const backImage = await pdfDoc.embedPng(imageBuffer);
    const backPage = pdfDoc.addPage([backImage.width, backImage.height]);
    backPage.drawImage(backImage, { x: 0, y: 0, width: backImage.width, height: backImage.height });
  }

  return Buffer.from(await pdfDoc.save());
};

app.post('/export', async (req, res) => {
  const { exportId, comicName, chapterNumber, format, pages, covers, compression } = req.body;

  console.log(`📋 Export queued: ${comicName} (${format.toUpperCase()}, position: ${exportQueue.length + 1})`);

  res.json({ success: true, message: 'Export queued', exportId });

  exportQueue.push(async () => {
    console.log(`🚀 Starting export: ${comicName}`);
    
    try {
      await updateExportStatus(exportId, 'processing');

      let fileBuffer;
      let mimeType;
      let fileExtension;

      if (format === 'cbz') {
        console.log(`📦 Generating CBZ: ${pages.length} pages (${compression || 'compressed'} mode)`);
        fileBuffer = await generateCBZ(pages, covers, compression);
        mimeType = 'application/zip';
        fileExtension = 'cbz';
      } else if (format === 'pdf') {
        console.log(`📄 Generating PDF: ${pages.length} pages (${compression || 'compressed'} mode)`);
        fileBuffer = await generatePDF(pages, covers, compression);
        mimeType = 'application/pdf';
        fileExtension = 'pdf';
      } else {
        throw new Error(`Unsupported format: ${format}`);
      }

      const fileSizeMB = (fileBuffer.length / 1024 / 1024).toFixed(2);
      console.log(`✅ Generated: ${fileSizeMB} MB`);

      // Tous les exports via Railway download link
      const downloadToken = `${exportId}_${Date.now()}`;
      exportFiles.set(downloadToken, {
        buffer: fileBuffer,
        mimeType,
        fileName: `${comicName}_Ch${chapterNumber}.${fileExtension}`,
        createdAt: Date.now()
      });

      const downloadUrl = `${req.protocol}://${req.get('host')}/download/${downloadToken}`;

      await updateExportStatus(exportId, 'completed', {
        file_url: downloadUrl,
        file_size: fileBuffer.length,
        file_format: format,
        compression: compression || 'compressed'
      });

      console.log(`✅ Export ready for download: ${downloadUrl}`);
    } catch (error) {
      console.error('❌ Export failed:', error);
      await updateExportStatus(exportId, 'failed', { error_message: error.message });
    }
  });

  processQueue();
});

// Download endpoint for all files
app.get('/download/:token', (req, res) => {
  const { token } = req.params;
  const fileData = exportFiles.get(token);

  if (!fileData) {
    return res.status(404).json({ error: 'File not found or expired' });
  }

  // Cleanup files > 24h
  const now = Date.now();
  for (const [key, data] of exportFiles.entries()) {
    if (now - data.createdAt > 24 * 60 * 60 * 1000) {
      exportFiles.delete(key);
    }
  }

  res.setHeader('Content-Type', fileData.mimeType);
  res.setHeader('Content-Disposition', `attachment; filename="${fileData.fileName}"`);
  res.send(fileData.buffer);
  
  // Optional: Delete immediately after download
  // exportFiles.delete(token);
  console.log(`📥 File downloaded: ${fileData.fileName}`);
});

// Status endpoint to check queue
app.get('/queue-status', (req, res) => {
  res.json({
    queue_length: exportQueue.length,
    is_processing: isProcessing,
    memory_files: exportFiles.size,
    status: isProcessing ? 'processing' : 'idle',
    next_task: exportQueue.length > 0 ? 'pending' : 'none'
  });
});

// Clear all files (admin endpoint)
app.post('/clear-files', (req, res) => {
  const { admin_key } = req.body;
  
  if (admin_key !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  
  const deletedCount = exportFiles.size;
  exportFiles.clear();
  
  res.json({
    success: true,
    message: `Cleared ${deletedCount} files`,
    files_remaining: exportFiles.size
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    queue: {
      length: exportQueue.length,
      is_processing: isProcessing
    },
    memory_usage: {
      files_stored: exportFiles.size,
      estimated_memory_mb: (exportFiles.size * 50) // Estimation
    }
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Export service on port ${PORT} with queue system`);
  console.log(`📁 All exports via Railway download links`);
});
