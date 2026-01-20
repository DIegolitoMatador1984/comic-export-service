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

// Queue system for sequential processing
const exportQueue = [];
let isProcessing = false;

// Storage for all exported files (temporary)
const exportFiles = new Map();

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

const downloadImage = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download: ${url}`);
  return Buffer.from(await response.arrayBuffer());
};

const compressImage = async (imageBuffer, quality = 85) => {
  if (quality === 98) {
    // Full HD: PNG minimal compression
    return sharp(imageBuffer)
      .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
      .png({ compression: 1 })
      .toBuffer();
  } else {
    // Compressed: JPEG pour réduire drastiquement
    return sharp(imageBuffer)
      .resize(1536, 1536, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 75, progressive: true })
      .toBuffer();
  }
};

const generateCBZ = async (pages, covers, compression = 'compressed') => {
  const compressionLevel = compression === 'fullhd' ? 1 : 9;
  const isFullHD = compression === 'fullhd';
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
        const finalCoverBuffer = await compressImage(coverBuffer, isFullHD ? 98 : 85);
        const coverExtension = isFullHD ? 'png' : 'jpg';
        archive.append(finalCoverBuffer, { name: `000_cover.${coverExtension}` });
        fileIndex++;
      }

      if (covers.chapter_cover) {
        const chapterCoverBuffer = await downloadImage(covers.chapter_cover);
        const finalChapterBuffer = await compressImage(chapterCoverBuffer, isFullHD ? 98 : 85);
        const chapterExtension = isFullHD ? 'png' : 'jpg';
        archive.append(finalChapterBuffer, { name: `001_chapter.${chapterExtension}` });
        fileIndex++;
      }

      for (const page of pages) {
        if (page.page_number === 0) continue;
        
        console.log(`Downloading page ${page.page_number}...`);
        const imageBuffer = await downloadImage(page.image_url);
        const finalImageBuffer = await compressImage(imageBuffer, isFullHD ? 98 : 85);
        const paddedNumber = String(fileIndex).padStart(3, '0');
        const extension = isFullHD ? 'png' : 'jpg';
        archive.append(finalImageBuffer, { name: `${paddedNumber}_page_${page.page_number}.${extension}` });
        fileIndex++;
      }

      if (covers.back_cover) {
        const backCoverBuffer = await downloadImage(covers.back_cover);
        const finalBackBuffer = await compressImage(backCoverBuffer, isFullHD ? 98 : 85);
        const backExtension = isFullHD ? 'png' : 'jpg';
        archive.append(finalBackBuffer, { name: `${String(fileIndex).padStart(3, '0')}_back.${backExtension}` });
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
  const isFullHD = compression === 'fullhd';

  if (covers.comic_cover) {
    const coverBuffer = await downloadImage(covers.comic_cover);
    const imageBuffer = await compressImage(coverBuffer, quality);
    const coverImage = isFullHD 
      ? await pdfDoc.embedPng(imageBuffer)
      : await pdfDoc.embedJpeg(imageBuffer);
    const coverPage = pdfDoc.addPage([coverImage.width, coverImage.height]);
    coverPage.drawImage(coverImage, { x: 0, y: 0, width: coverImage.width, height: coverImage.height });
  }

  if (covers.chapter_cover) {
    const chapterBuffer = await downloadImage(covers.chapter_cover);
    const imageBuffer = await compressImage(chapterBuffer, quality);
    const chapterImage = isFullHD 
      ? await pdfDoc.embedPng(imageBuffer)
      : await pdfDoc.embedJpeg(imageBuffer);
    const chapterPage = pdfDoc.addPage([chapterImage.width, chapterImage.height]);
    chapterPage.drawImage(chapterImage, { x: 0, y: 0, width: chapterImage.width, height: chapterImage.height });
  }

  for (const page of pages) {
    if (page.page_number === 0) continue;
    
    console.log(`Processing page ${page.page_number}...`);
    const imageBuffer = await downloadImage(page.image_url);
    const finalBuffer = await compressImage(imageBuffer, quality);
    const image = isFullHD 
      ? await pdfDoc.embedPng(finalBuffer)
      : await pdfDoc.embedJpeg(finalBuffer);
    const pdfPage = pdfDoc.addPage([image.width, image.height]);
    pdfPage.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  }

  if (covers.back_cover) {
    const backBuffer = await downloadImage(covers.back_cover);
    const imageBuffer = await compressImage(backBuffer, quality);
    const backImage = isFullHD 
      ? await pdfDoc.embedPng(imageBuffer)
      : await pdfDoc.embedJpeg(imageBuffer);
    const backPage = pdfDoc.addPage([backImage.width, backImage.height]);
    backPage.drawImage(backImage, { x: 0, y: 0, width: backImage.width, height: backImage.height });
  }

  return Buffer.from(await pdfDoc.save());
};

// Queue processor
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
  if (exportQueue.length > 0) {
    console.log(`📋 Queue size: ${exportQueue.length} remaining`);
    processQueue();
  } else {
    console.log('✅ Queue empty');
  }
};

app.post('/export', async (req, res) => {
  const { exportId, comicName, chapterNumber, format, pages, covers, compression = 'compressed' } = req.body;

  console.log(`📋 Export queued: ${comicName} (${format.toUpperCase()}, ${compression}, position: ${exportQueue.length + 1})`);

  res.json({ 
    success: true, 
    message: 'Export queued', 
    exportId,
    queuePosition: exportQueue.length + 1
  });

  exportQueue.push(async () => {
    console.log(`🚀 Starting export: ${comicName} - ${format.toUpperCase()} (${compression})`);
    
    try {
      await updateExportStatus(exportId, 'processing');

      let fileBuffer;
      let mimeType;
      let fileExtension;

      if (format === 'cbz') {
        fileBuffer = await generateCBZ(pages, covers, compression);
        mimeType = 'application/zip';
        fileExtension = 'cbz';
      } else if (format === 'pdf') {
        fileBuffer = await generatePDF(pages, covers, compression);
        mimeType = 'application/pdf';
        fileExtension = 'pdf';
      } else {
        throw new Error(`Format non supporté: ${format}`);
      }

      const fileSizeMB = (fileBuffer.length / 1024 / 1024).toFixed(2);
      console.log(`✅ Generated: ${fileSizeMB} MB (${compression})`);

      // Tous les exports via Railway download link
      const downloadToken = `${exportId}_${Date.now()}`;
      exportFiles.set(downloadToken, {
        buffer: fileBuffer,
        mimeType,
        fileName: `${comicName}_Ch${chapterNumber}_${compression}.${fileExtension}`,
        createdAt: Date.now()
      });

      const downloadUrl = `${process.env.RAILWAY_PUBLIC_DOMAIN || 'https://comic-export-service-production.up.railway.app'}/download/${downloadToken}`;

      await updateExportStatus(exportId, 'completed', {
        file_url: downloadUrl,
        file_size: fileBuffer.length,
        file_size_mb: fileSizeMB,
        compression: compression
      });

      console.log(`✅ Export ready for download! (${compression})`);
    } catch (error) {
      console.error('❌ Export failed:', error);
      await updateExportStatus(exportId, 'failed', { 
        error_message: error.message,
        compression: compression
      });
    }
  });

  processQueue();
});

// Download endpoint for ALL exported files
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
  exportFiles.delete(token);
});

// Queue status endpoint
app.get('/queue-status', (req, res) => {
  res.json({
    isProcessing,
    queueSize: exportQueue.length,
    itemsInQueue: exportQueue.length,
    storage: {
      activeFiles: exportFiles.size
    }
  });
});

// Cleanup endpoint (optional, for maintenance)
app.post('/cleanup', (req, res) => {
  const now = Date.now();
  let deletedCount = 0;
  
  for (const [key, data] of exportFiles.entries()) {
    if (now - data.createdAt > 24 * 60 * 60 * 1000) {
      exportFiles.delete(key);
      deletedCount++;
    }
  }
  
  res.json({
    message: `Cleaned up ${deletedCount} expired files`,
    remainingFiles: exportFiles.size
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    queue: {
      processing: isProcessing,
      pending: exportQueue.length
    },
    storage: {
      activeDownloads: exportFiles.size
    }
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Export service on port ${PORT}`);
  console.log(`📋 Queue system ready`);
  console.log(`💾 All exports via Railway temporary storage`);
  console.log(`🎯 Compression modes: fullhd (PNG 2048px) | compressed (JPEG 1536px 75%)`);
});
