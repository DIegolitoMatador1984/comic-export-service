// Railway Export Service - Refactored with Queue & Memory Management
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const archiver = require('archiver');
const { PDFDocument } = require('pdf-lib');
const sharp = require('sharp');
const { createClient } = require('@supabase/supabase-js');
const { PassThrough } = require('stream');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' })); // Reduced - we don't need big payloads

// ============================================
// QUEUE SYSTEM - Prevents memory overload
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
      this.process(); // Process next in queue
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

// Max 2 concurrent exports to stay under Railway memory limits
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
// IMAGE PROCESSING - Memory optimized
// ============================================
const downloadAndProcessImage = async (url, quality = 85) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download: ${url}`);
  
  const inputBuffer = Buffer.from(await response.arrayBuffer());
  
  // Process with sharp - memory efficient
  const processed = await sharp(inputBuffer)
    .resize(2048, 2048, { 
      fit: 'inside', 
      withoutEnlargement: true 
    })
    .png({ 
      compressionLevel: quality === 98 ? 1 : 6,
      effort: quality === 98 ? 1 : 7
    })
    .toBuffer();
  
  // Explicitly release input buffer
  inputBuffer.fill(0);
  
  return processed;
};

// Download without processing (for CBZ)
const downloadImage = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download: ${url}`);
  return Buffer.from(await response.arrayBuffer());
};

// ============================================
// CBZ GENERATION - Streaming to Supabase
// ============================================
const generateAndUploadCBZ = async (exportId, pages, covers, compression, fileName, supabase) => {
  const chunks = [];
  const archive = archiver('zip', { 
    zlib: { level: compression === 'fullhd' ? 1 : 6 } 
  });

  archive.on('data', chunk => chunks.push(chunk));

  return new Promise(async (resolve, reject) => {
    archive.on('error', reject);
    archive.on('end', async () => {
      try {
        const finalBuffer = Buffer.concat(chunks);
        console.log(`📦 [${exportId}] CBZ generated: ${(finalBuffer.length / 1024 / 1024).toFixed(2)} MB`);

        // Upload to Supabase
        const { error } = await supabase.storage
          .from('comics')
          .upload(fileName, finalBuffer, { 
            contentType: 'application/zip',
            upsert: true
          });

        if (error) throw error;

        const { data: { publicUrl } } = supabase.storage
          .from('comics')
          .getPublicUrl(fileName);

        resolve({ url: publicUrl, size: finalBuffer.length });
      } catch (err) {
        reject(err);
      }
    });

    try {
      let fileIndex = 0;

      // Process covers
      if (covers.comic_cover) {
        console.log(`📥 [${exportId}] Downloading comic cover...`);
        const buffer = await downloadImage(covers.comic_cover);
        archive.append(buffer, { name: `000_cover.png` });
        fileIndex++;
      }

      if (covers.chapter_cover) {
        console.log(`📥 [${exportId}] Downloading chapter cover...`);
        const buffer = await downloadImage(covers.chapter_cover);
        archive.append(buffer, { name: `001_chapter.png` });
        fileIndex++;
      }

      // Process pages ONE BY ONE to control memory
      for (const page of pages) {
        if (page.page_number === 0) continue;
        
        console.log(`📥 [${exportId}] Page ${page.page_number}/${pages.length}...`);
        const buffer = await downloadImage(page.image_url);
        const paddedNumber = String(fileIndex).padStart(3, '0');
        archive.append(buffer, { name: `${paddedNumber}_page_${page.page_number}.png` });
        fileIndex++;
        
        // Force garbage collection hint
        if (global.gc) global.gc();
      }

      if (covers.back_cover) {
        console.log(`📥 [${exportId}] Downloading back cover...`);
        const buffer = await downloadImage(covers.back_cover);
        archive.append(buffer, { name: `${String(fileIndex).padStart(3, '0')}_back.png` });
      }

      archive.finalize();
    } catch (error) {
      reject(error);
    }
  });
};

// ============================================
// PDF GENERATION - Chunked processing
// ============================================
const generateAndUploadPDF = async (exportId, pages, covers, compression, fileName, supabase) => {
  const pdfDoc = await PDFDocument.create();
  const quality = compression === 'fullhd' ? 98 : 85;
  
  const totalItems = [
    covers.comic_cover,
    covers.chapter_cover,
    ...pages.filter(p => p.page_number > 0),
    covers.back_cover
  ].filter(Boolean).length;
  
  let processed = 0;

  const addImageToPdf = async (imageUrl, label) => {
    console.log(`📄 [${exportId}] ${label} (${++processed}/${totalItems})...`);
    
    const imageBuffer = await downloadAndProcessImage(imageUrl, quality);
    const image = await pdfDoc.embedPng(imageBuffer);
    const page = pdfDoc.addPage([image.width, image.height]);
    page.drawImage(image, { 
      x: 0, 
      y: 0, 
      width: image.width, 
      height: image.height 
    });
    
    // Release buffer
    imageBuffer.fill(0);
  };

  try {
    // Covers
    if (covers.comic_cover) {
      await addImageToPdf(covers.comic_cover, 'Comic cover');
    }
    if (covers.chapter_cover) {
      await addImageToPdf(covers.chapter_cover, 'Chapter cover');
    }

    // Pages - one by one
    for (const page of pages) {
      if (page.page_number === 0) continue;
      await addImageToPdf(page.image_url, `Page ${page.page_number}`);
    }

    // Back cover
    if (covers.back_cover) {
      await addImageToPdf(covers.back_cover, 'Back cover');
    }

    // Save PDF
    console.log(`💾 [${exportId}] Saving PDF...`);
    const pdfBytes = await pdfDoc.save();
    const pdfBuffer = Buffer.from(pdfBytes);
    
    console.log(`📦 [${exportId}] PDF generated: ${(pdfBuffer.length / 1024 / 1024).toFixed(2)} MB`);

    // Upload to Supabase
    const { error } = await supabase.storage
      .from('comics')
      .upload(fileName, pdfBuffer, { 
        contentType: 'application/pdf',
        upsert: true
      });

    if (error) throw error;

    const { data: { publicUrl } } = supabase.storage
      .from('comics')
      .getPublicUrl(fileName);

    return { url: publicUrl, size: pdfBuffer.length };
    
  } catch (error) {
    throw error;
  }
};

// ============================================
// MAIN EXPORT ENDPOINT
// ============================================
app.post('/export', async (req, res) => {
  const { exportId, comicName, chapterNumber, format, pages, covers, compression } = req.body;

  // Validation
  if (!exportId || !pages || pages.length === 0) {
    return res.status(400).json({ success: false, error: 'Invalid request' });
  }

  const queueStatus = exportQueue.getStatus();
  console.log(`📬 [${exportId}] Export queued. Queue: ${queueStatus.queued} waiting, ${queueStatus.running} running`);

  // Respond immediately with queue position
  res.json({ 
    success: true, 
    message: 'Export queued',
    exportId,
    queuePosition: queueStatus.queued + 1
  });

  // Add to queue
  exportQueue.add(async () => {
    const startTime = Date.now();
    
    try {
      await updateExportStatus(exportId, 'processing');
      
      const supabase = getSupabaseClient();
      const sanitizedName = comicName.replace(/[^a-zA-Z0-9]/g, '_');
      const timestamp = Date.now();
      const fileExtension = format === 'pdf' ? 'pdf' : 'cbz';
      const fileName = `exports/${sanitizedName}_Ch${chapterNumber}_${timestamp}.${fileExtension}`;

      let result;

      if (format === 'cbz') {
        result = await generateAndUploadCBZ(
          exportId, pages, covers, compression, fileName, supabase
        );
      } else {
        result = await generateAndUploadPDF(
          exportId, pages, covers, compression, fileName, supabase
        );
      }

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
});
