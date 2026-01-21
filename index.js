// Railway Export Service - All uploads to Supabase
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const archiver = require('archiver');
const { PDFDocument } = require('pdf-lib');
const sharp = require('sharp');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

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

// For COMPRESSED mode - resize and keep as optimized PNG
const processImageCompressed = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download: ${url}`);
  
  const inputBuffer = Buffer.from(await response.arrayBuffer());
  
  // Resize and compress as PNG (JPEG was causing blank pages in pdf-lib)
  const processed = await sharp(inputBuffer)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
    .png({ compressionLevel: 9, palette: true }) // High compression PNG
    .toBuffer();
  
  console.log(`   Compressed: ${(inputBuffer.length/1024).toFixed(0)}KB → ${(processed.length/1024).toFixed(0)}KB`);
  
  inputBuffer.fill(0);
  return processed;
};

// For FULL HD mode - keep full resolution, light compression (80% quality = 20% reduction)
const processImageFullHD = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download: ${url}`);
  
  const inputBuffer = Buffer.from(await response.arrayBuffer());
  
  // Keep original size, just optimize PNG compression
  const processed = await sharp(inputBuffer)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .png({ compressionLevel: 6 }) // Medium compression (faster, still good quality)
    .toBuffer();
  
  console.log(`   Full HD: ${(inputBuffer.length/1024).toFixed(0)}KB → ${(processed.length/1024).toFixed(0)}KB`);
  
  inputBuffer.fill(0);
  return processed;
};

// Download original without any processing (fallback)
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
    zlib: { level: isFullHD ? 6 : 9 }  // Good compression for both
  });

  archive.on('data', chunk => chunks.push(chunk));

  return new Promise(async (resolve, reject) => {
    archive.on('error', reject);
    archive.on('end', () => {
      resolve(Buffer.concat(chunks));
    });

    try {
      let fileIndex = 0;
      const downloadFn = isFullHD ? processImageFullHD : processImageCompressed;
      const ext = 'png'; // Always PNG for best compatibility

      // Comic cover (from covers object)
      if (covers.comic_cover) {
        console.log(`📥 [${exportId}] Comic cover...`);
        const buffer = await downloadFn(covers.comic_cover);
        archive.append(buffer, { name: `${String(fileIndex).padStart(3, '0')}_comic_cover.${ext}` });
        fileIndex++;
      }

      // Chapter cover (from covers object OR page 0)
      if (covers.chapter_cover) {
        console.log(`📥 [${exportId}] Chapter cover...`);
        const buffer = await downloadFn(covers.chapter_cover);
        archive.append(buffer, { name: `${String(fileIndex).padStart(3, '0')}_chapter_cover.${ext}` });
        fileIndex++;
      }

      // Page 0 is the chapter cover if not already added via covers.chapter_cover
      const page0 = pages.find(p => p.page_number === 0);
      if (page0 && page0.image_url && !covers.chapter_cover) {
        console.log(`📥 [${exportId}] Page 0 (chapter cover)...`);
        const buffer = await downloadFn(page0.image_url);
        archive.append(buffer, { name: `${String(fileIndex).padStart(3, '0')}_chapter_cover.${ext}` });
        fileIndex++;
      }

      // Regular pages (page_number > 0)
      const regularPages = pages.filter(p => p.page_number > 0 && p.image_url).sort((a, b) => a.page_number - b.page_number);
      
      for (const page of regularPages) {
        console.log(`📥 [${exportId}] Page ${page.page_number}/${regularPages.length}...`);
        const buffer = await downloadFn(page.image_url);
        archive.append(buffer, { name: `${String(fileIndex).padStart(3, '0')}_page_${page.page_number}.${ext}` });
        fileIndex++;
      }

      // Back cover
      if (covers.back_cover) {
        console.log(`📥 [${exportId}] Back cover...`);
        const buffer = await downloadFn(covers.back_cover);
        archive.append(buffer, { name: `${String(fileIndex).padStart(3, '0')}_back_cover.${ext}` });
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
  
  // Count total items for progress
  const page0 = pages.find(p => p.page_number === 0);
  const regularPages = pages.filter(p => p.page_number > 0 && p.image_url).sort((a, b) => a.page_number - b.page_number);
  
  let totalItems = regularPages.length;
  if (covers.comic_cover) totalItems++;
  if (covers.chapter_cover || page0) totalItems++;
  if (covers.back_cover) totalItems++;
  
  let processed = 0;

  const addImageToPdf = async (imageUrl, label) => {
    console.log(`📄 [${exportId}] ${label} (${++processed}/${totalItems})...`);
    
    let imageBuffer;
    
    if (isFullHD) {
      imageBuffer = await processImageFullHD(imageUrl);
    } else {
      imageBuffer = await processImageCompressed(imageUrl);
    }
    
    // Always use embedPng since JPEG was causing blank pages
    const image = await pdfDoc.embedPng(imageBuffer);
    
    const page = pdfDoc.addPage([image.width, image.height]);
    page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
    
    imageBuffer.fill(0);
  };

  try {
    // Comic cover
    if (covers.comic_cover) {
      await addImageToPdf(covers.comic_cover, 'Comic cover');
    }
    
    // Chapter cover (from covers object OR page 0)
    if (covers.chapter_cover) {
      await addImageToPdf(covers.chapter_cover, 'Chapter cover');
    } else if (page0 && page0.image_url) {
      await addImageToPdf(page0.image_url, 'Page 0 (chapter cover)');
    }

    // Regular pages
    for (const page of regularPages) {
      await addImageToPdf(page.image_url, `Page ${page.page_number}`);
    }

    // Back cover
    if (covers.back_cover) {
      await addImageToPdf(covers.back_cover, 'Back cover');
    }

    console.log(`💾 [${exportId}] Saving PDF...`);
    const pdfBytes = await pdfDoc.save();
    return Buffer.from(pdfBytes);
    
  } catch (error) {
    throw error;
  }
};

// ============================================
// UPLOAD TO SUPABASE (for both compressed and Full HD)
// ============================================
const uploadToSupabase = async (exportId, fileBuffer, fileName, mimeType, compression) => {
  const fileSizeMB = fileBuffer.length / 1024 / 1024;
  console.log(`📦 [${exportId}] Generated: ${fileSizeMB.toFixed(2)} MB (${compression})`);

  const supabase = getSupabaseClient();
  const storagePath = `exports/${fileName}`;
  
  const { error } = await supabase.storage
    .from('comics')
    .upload(storagePath, fileBuffer, { 
      contentType: mimeType,
      upsert: true
    });

  if (error) {
    throw new Error(`Supabase upload failed: ${error.message}`);
  }

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
      const fileExtension = format === 'pdf' ? 'pdf' : 'cbz';
      // Filename based on comic + chapter + compression (no timestamp = overwrites previous)
      const fileName = `${sanitizedName}_Ch${chapterNumber}_${compression}.${fileExtension}`;
      const mimeType = format === 'pdf' ? 'application/pdf' : 'application/zip';

      let fileBuffer;

      if (format === 'cbz') {
        fileBuffer = await generateCBZ(exportId, pages, covers, compression);
      } else {
        fileBuffer = await generatePDF(exportId, pages, covers, compression);
      }

      const result = await uploadToSupabase(exportId, fileBuffer, fileName, mimeType, compression);
      
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
// STATUS ENDPOINT
// ============================================
app.get('/status', (req, res) => {
  const status = exportQueue.getStatus();
  const memUsage = process.memoryUsage();
  
  res.json({
    queue: status,
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
  console.log(`☁️ All files uploaded to Supabase`);
});
