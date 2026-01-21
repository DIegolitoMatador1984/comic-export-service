// Railway Export Service - Dual Storage Strategy
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const archiver = require('archiver');
const { PDFDocument } = require('pdf-lib');
const sharp = require('sharp');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ============================================
// TEMPORARY FILE STORAGE (for Full HD)
// ============================================
const tempFiles = new Map();
const TEMP_DIR = path.join(os.tmpdir(), 'comic-exports');

// Ensure temp directory exists
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Cleanup old files every 10 minutes
setInterval(() => {
  const now = Date.now();
  const maxAge = 2 * 60 * 60 * 1000; // 2 hours
  
  for (const [token, data] of tempFiles.entries()) {
    if (now - data.createdAt > maxAge) {
      // Delete file from disk
      if (fs.existsSync(data.filePath)) {
        fs.unlinkSync(data.filePath);
        console.log(`🗑️ Cleaned up expired file: ${token}`);
      }
      tempFiles.delete(token);
    }
  }
}, 10 * 60 * 1000);

// ============================================
// QUEUE SYSTEM
// ============================================
class ExportQueue {
  constructor(maxConcurrent = 2) {
    this.queue = [];
    this.running = 0;
    this.maxConcurrent = maxConcurrent;
  }

  async add(job) {
    return new Promise((resolve, reject) => {
      this.queue.push({ job, resolve, reject });
      this.process();
    });
  }

  async process() {
    if (this.running >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }

    this.running++;
    const { job, resolve, reject } = this.queue.shift();

    try {
      const result = await job();
      resolve(result);
    } catch (error) {
      reject(error);
    } finally {
      this.running--;
      this.process();
    }
  }

  getStatus() {
    return {
      queued: this.queue.length,
      running: this.running,
      maxConcurrent: this.maxConcurrent
    };
  }
}

const exportQueue = new ExportQueue(2);

// ============================================
// SUPABASE CLIENT
// ============================================
const getSupabaseClient = () => {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
};

// ============================================
// STATUS UPDATE
// ============================================
const updateExportStatus = async (exportId, status, data = {}) => {
  try {
    const response = await fetch(
      'https://preview--comicreate-5f5892c3.base44.app/api/apps/69625406b9fddce15f5892c3/functions/updateExportStatus',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ export_id: exportId, status, ...data })
      }
    );
    
    if (!response.ok) {
      console.error('Failed to update status:', await response.text());
    } else {
      console.log(`✅ [${exportId}] Status: ${status}`);
    }
  } catch (error) {
    console.error(`❌ [${exportId}] Error updating status:`, error.message);
  }
};

// ============================================
// IMAGE PROCESSING
// ============================================

// For COMPRESSED mode - resize and convert to JPEG
const processImageCompressed = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download: ${url}`);
  
  const inputBuffer = Buffer.from(await response.arrayBuffer());
  
  const processed = await sharp(inputBuffer)
    .resize(1400, 1400, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
  
  inputBuffer.fill(0);
  return processed;
};

// For FULL HD mode - keep original quality, just download
const downloadImageOriginal = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download: ${url}`);
  return Buffer.from(await response.arrayBuffer());
};

// ============================================
// CBZ GENERATION
// ============================================
const generateCBZ = async (exportId, pages, covers, compression) => {
  const isFullHD = compression === 'fullhd';
  const chunks = [];
  
  const archive = archiver('zip', { 
    zlib: { level: isFullHD ? 1 : 6 }  // Less compression for Full HD (faster)
  });

  archive.on('data', chunk => chunks.push(chunk));

  return new Promise(async (resolve, reject) => {
    archive.on('error', reject);
    archive.on('end', () => {
      resolve(Buffer.concat(chunks));
    });

    try {
      let fileIndex = 0;
      const downloadFn = isFullHD ? downloadImageOriginal : processImageCompressed;
      const ext = isFullHD ? 'png' : 'jpg';

      if (covers.comic_cover) {
        console.log(`📥 [${exportId}] Cover...`);
        const buffer = await downloadFn(covers.comic_cover);
        archive.append(buffer, { name: `000_cover.${ext}` });
        fileIndex++;
      }

      if (covers.chapter_cover) {
        console.log(`📥 [${exportId}] Chapter cover...`);
        const buffer = await downloadFn(covers.chapter_cover);
        archive.append(buffer, { name: `001_chapter.${ext}` });
        fileIndex++;
      }

      for (const page of pages) {
        if (page.page_number === 0) continue;
        
        console.log(`📥 [${exportId}] Page ${page.page_number}/${pages.length}...`);
        const buffer = await downloadFn(page.image_url);
        const paddedNumber = String(fileIndex).padStart(3, '0');
        archive.append(buffer, { name: `${paddedNumber}_page_${page.page_number}.${ext}` });
        fileIndex++;
      }

      if (covers.back_cover) {
        console.log(`📥 [${exportId}] Back cover...`);
        const buffer = await downloadFn(covers.back_cover);
        archive.append(buffer, { name: `${String(fileIndex).padStart(3, '0')}_back.${ext}` });
      }

      archive.finalize();
    } catch (error) {
      reject(error);
    }
  });
};

// ============================================
// PDF GENERATION
// ============================================
const generatePDF = async (exportId, pages, covers, compression) => {
  const pdfDoc = await PDFDocument.create();
  const isFullHD = compression === 'fullhd';
  
  const totalItems = [
    covers.comic_cover,
    covers.chapter_cover,
    ...pages.filter(p => p.page_number > 0),
    covers.back_cover
  ].filter(Boolean).length;
  
  let processed = 0;

  const addImageToPdf = async (imageUrl, label) => {
    console.log(`📄 [${exportId}] ${label} (${++processed}/${totalItems})...`);
    
    let imageBuffer;
    let image;
    
    if (isFullHD) {
      // Full HD: Keep original PNG
      imageBuffer = await downloadImageOriginal(imageUrl);
      image = await pdfDoc.embedPng(imageBuffer);
    } else {
      // Compressed: Use JPEG
      imageBuffer = await processImageCompressed(imageUrl);
      image = await pdfDoc.embedJpg(imageBuffer);
    }
    
    const page = pdfDoc.addPage([image.width, image.height]);
    page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
    
    imageBuffer.fill(0);
  };

  try {
    if (covers.comic_cover) await addImageToPdf(covers.comic_cover, 'Comic cover');
    if (covers.chapter_cover) await addImageToPdf(covers.chapter_cover, 'Chapter cover');

    for (const page of pages) {
      if (page.page_number === 0) continue;
      await addImageToPdf(page.image_url, `Page ${page.page_number}`);
    }

    if (covers.back_cover) await addImageToPdf(covers.back_cover, 'Back cover');

    console.log(`💾 [${exportId}] Saving PDF...`);
    const pdfBytes = await pdfDoc.save();
    return Buffer.from(pdfBytes);
    
  } catch (error) {
    throw error;
  }
};

// ============================================
// UPLOAD / STORE LOGIC
// ============================================
const storeFile = async (exportId, fileBuffer, fileName, mimeType, compression) => {
  const isFullHD = compression === 'fullhd';
  const fileSizeMB = fileBuffer.length / 1024 / 1024;
  
  console.log(`📦 [${exportId}] Generated: ${fileSizeMB.toFixed(2)} MB (${compression})`);

  // FULL HD: Store on disk, return Railway download link
  if (isFullHD) {
    const downloadToken = `${exportId}_${Date.now()}`;
    const filePath = path.join(TEMP_DIR, `${downloadToken}_${fileName}`);
    
    // Write to disk instead of keeping in memory
    fs.writeFileSync(filePath, fileBuffer);
    
    tempFiles.set(downloadToken, {
      filePath,
      mimeType,
      fileName,
      createdAt: Date.now()
    });

    const railwayUrl = process.env.RAILWAY_PUBLIC_DOMAIN || 'comic-export-service-production.up.railway.app';
    const downloadUrl = `https://${railwayUrl}/download/${downloadToken}`;
    
    console.log(`🔗 [${exportId}] Full HD stored temporarily: ${downloadToken}`);
    
    return { url: downloadUrl, size: fileBuffer.length };
  }

  // COMPRESSED: Upload to Supabase
  const supabase = getSupabaseClient();
  const storagePath = `exports/${fileName}`;
  
  const { error } = await supabase.storage
    .from('comics')
    .upload(storagePath, fileBuffer, { 
      contentType: mimeType,
      upsert: true
    });

  if (error) throw new Error(`Supabase upload failed: ${error.message}`);

  const { data: { publicUrl } } = supabase.storage
    .from('comics')
    .getPublicUrl(storagePath);

  console.log(`☁️ [${exportId}] Uploaded to Supabase`);
  
  return { url: publicUrl, size: fileBuffer.length };
};

// ============================================
// MAIN EXPORT ENDPOINT
// ============================================
app.post('/export', async (req, res) => {
  const { exportId, comicName, chapterNumber, format, pages, covers, compression } = req.body;

  if (!exportId || !pages || pages.length === 0) {
    return res.status(400).json({ success: false, error: 'Invalid request' });
  }

  const queueStatus = exportQueue.getStatus();
  console.log(`📬 [${exportId}] Queued (${compression}). Queue: ${queueStatus.queued} waiting, ${queueStatus.running} running`);

  res.json({ 
    success: true, 
    message: 'Export queued',
    exportId,
    queuePosition: queueStatus.queued + 1
  });

  exportQueue.add(async () => {
    const startTime = Date.now();
    
    try {
      await updateExportStatus(exportId, 'processing');
      
      const sanitizedName = comicName.replace(/[^a-zA-Z0-9]/g, '_');
      const timestamp = Date.now();
      const fileExtension = format === 'pdf' ? 'pdf' : 'cbz';
      const fileName = `${sanitizedName}_Ch${chapterNumber}_${timestamp}.${fileExtension}`;
      const mimeType = format === 'pdf' ? 'application/pdf' : 'application/zip';

      let fileBuffer;

      if (format === 'cbz') {
        fileBuffer = await generateCBZ(exportId, pages, covers, compression);
      } else {
        fileBuffer = await generatePDF(exportId, pages, covers, compression);
      }

      const result = await storeFile(exportId, fileBuffer, fileName, mimeType, compression);
      
      // Free memory
      fileBuffer = null;

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`✅ [${exportId}] Completed in ${duration}s`);

      await updateExportStatus(exportId, 'completed', {
        file_url: result.url,
        file_size: result.size
      });

    } catch (error) {
      console.error(`❌ [${exportId}] Failed:`, error.message);
      await updateExportStatus(exportId, 'failed', {
        error_message: error.message
      });
    }
  }).catch(error => {
    console.error(`❌ [${exportId}] Queue error:`, error.message);
  });
});

// ============================================
// DOWNLOAD ENDPOINT (for Full HD files)
// ============================================
app.get('/download/:token', (req, res) => {
  const { token } = req.params;
  const fileData = tempFiles.get(token);

  if (!fileData) {
    return res.status(404).json({ error: 'File not found or expired. Full HD downloads expire after 2 hours.' });
  }

  if (!fs.existsSync(fileData.filePath)) {
    tempFiles.delete(token);
    return res.status(404).json({ error: 'File no longer available' });
  }

  console.log(`📥 Download: ${token}`);
  
  res.setHeader('Content-Type', fileData.mimeType);
  res.setHeader('Content-Disposition', `attachment; filename="${fileData.fileName}"`);
  
  // Stream file from disk
  const fileStream = fs.createReadStream(fileData.filePath);
  fileStream.pipe(res);
  
  // Delete after download
  fileStream.on('end', () => {
    fs.unlink(fileData.filePath, () => {});
    tempFiles.delete(token);
    console.log(`🗑️ Downloaded and cleaned: ${token}`);
  });
});

// ============================================
// STATUS ENDPOINT
// ============================================
app.get('/status', (req, res) => {
  const status = exportQueue.getStatus();
  const memUsage = process.memoryUsage();
  
  res.json({
    queue: status,
    tempFiles: tempFiles.size,
    memory: {
      heapUsed: `${(memUsage.heapUsed / 1024 / 1024).toFixed(2)} MB`,
      heapTotal: `${(memUsage.heapTotal / 1024 / 1024).toFixed(2)} MB`,
      rss: `${(memUsage.rss / 1024 / 1024).toFixed(2)} MB`
    }
  });
});

// ============================================
// HEALTH CHECK
// ============================================
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================
// START SERVER
// ============================================
app.listen(PORT, () => {
  console.log(`🚀 Export service running on port ${PORT}`);
  console.log(`📊 Max concurrent exports: ${exportQueue.maxConcurrent}`);
  console.log(`📁 Temp directory: ${TEMP_DIR}`);
});
