// Railway Export Service for Comic Creator
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
app.use(express.json({ limit: '50mb' }));

const getSupabaseClient = () => {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
};

const updateExportStatus = async (exportId, status, data = {}) => {
  try {
    const response = await fetch(`${process.env.BASE44_API_URL}/entities/Export/${exportId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.BASE44_SERVICE_ROLE_KEY}`
      },
      body: JSON.stringify({ status, ...data })
    });
  } catch (error) {
    console.error('Error updating status:', error);
  }
};

const downloadImage = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download: ${url}`);
  return Buffer.from(await response.arrayBuffer());
};

const compressImage = async (imageBuffer) => {
  return sharp(imageBuffer)
    .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
};

const generateCBZ = async (pages, covers) => {
  const archive = archiver('zip', { zlib: { level: 9 } });
  const chunks = [];

  archive.on('data', (chunk) => chunks.push(chunk));
  
  return new Promise(async (resolve, reject) => {
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);

    try {
      let fileIndex = 0;

      if (covers.comic_cover) {
        const coverBuffer = await downloadImage(covers.comic_cover);
        archive.append(coverBuffer, { name: `000_cover.jpg` });
        fileIndex++;
      }

      if (covers.chapter_cover) {
        const chapterCoverBuffer = await downloadImage(covers.chapter_cover);
        archive.append(chapterCoverBuffer, { name: `001_chapter.jpg` });
        fileIndex++;
      }

      for (const page of pages) {
        console.log(`Downloading page ${page.page_number}...`);
        const imageBuffer = await downloadImage(page.image_url);
        const paddedNumber = String(fileIndex).padStart(3, '0');
        archive.append(imageBuffer, { name: `${paddedNumber}_page_${page.page_number}.jpg` });
        fileIndex++;
      }

      if (covers.back_cover) {
        const backCoverBuffer = await downloadImage(covers.back_cover);
        archive.append(backCoverBuffer, { name: `${String(fileIndex).padStart(3, '0')}_back.jpg` });
      }

      archive.finalize();
    } catch (error) {
      reject(error);
    }
  });
};

const generatePDF = async (pages, covers) => {
  const pdfDoc = await PDFDocument.create();

  if (covers.comic_cover) {
    const coverBuffer = await downloadImage(covers.comic_cover);
    const compressedCover = await compressImage(coverBuffer);
    const coverImage = await pdfDoc.embedJpg(compressedCover);
    const coverPage = pdfDoc.addPage([coverImage.width, coverImage.height]);
    coverPage.drawImage(coverImage, { x: 0, y: 0, width: coverImage.width, height: coverImage.height });
  }

  if (covers.chapter_cover) {
    const chapterBuffer = await downloadImage(covers.chapter_cover);
    const compressedChapter = await compressImage(chapterBuffer);
    const chapterImage = await pdfDoc.embedJpg(compressedChapter);
    const chapterPage = pdfDoc.addPage([chapterImage.width, chapterImage.height]);
    chapterPage.drawImage(chapterImage, { x: 0, y: 0, width: chapterImage.width, height: chapterImage.height });
  }

  for (const page of pages) {
    console.log(`Processing page ${page.page_number}...`);
    const imageBuffer = await downloadImage(page.image_url);
    const compressedImage = await compressImage(imageBuffer);
    const image = await pdfDoc.embedJpg(compressedImage);
    const pdfPage = pdfDoc.addPage([image.width, image.height]);
    pdfPage.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  }

  if (covers.back_cover) {
    const backBuffer = await downloadImage(covers.back_cover);
    const compressedBack = await compressImage(backBuffer);
    const backImage = await pdfDoc.embedJpg(compressedBack);
    const backPage = pdfDoc.addPage([backImage.width, backImage.height]);
    backPage.drawImage(backImage, { x: 0, y: 0, width: backImage.width, height: backImage.height });
  }

  return Buffer.from(await pdfDoc.save());
};

app.post('/export', async (req, res) => {
  const { exportId, comicName, chapterNumber, format, pages, covers } = req.body;

  console.log(`🚀 Starting ${format.toUpperCase()} export: ${pages.length} pages`);

  res.json({ success: true, message: 'Export started', exportId });

  (async () => {
    try {
      await updateExportStatus(exportId, 'processing');

      let fileBuffer;
      let mimeType;
      let fileExtension;

      if (format === 'cbz') {
        fileBuffer = await generateCBZ(pages, covers);
        mimeType = 'application/zip';
        fileExtension = 'cbz';
      } else if (format === 'pdf') {
        fileBuffer = await generatePDF(pages, covers);
        mimeType = 'application/pdf';
        fileExtension = 'pdf';
      }

      console.log(`✅ Generated: ${fileBuffer.length} bytes`);

      const supabase = getSupabaseClient();
      const fileName = `exports/${comicName}_Ch${chapterNumber}_${Date.now()}.${fileExtension}`;
      
      const { error: uploadError } = await supabase.storage
        .from('comics')
        .upload(fileName, fileBuffer, { contentType: mimeType });

      if (uploadError) throw uploadError;

      const { data: { publicUrl } } = supabase.storage
        .from('comics')
        .getPublicUrl(fileName);

      await updateExportStatus(exportId, 'completed', {
        file_url: publicUrl,
        file_size: fileBuffer.length
      });

      console.log('✅ Export completed!');
    } catch (error) {
      console.error('❌ Export failed:', error);
      await updateExportStatus(exportId, 'failed', {
        error_message: error.message
      });
    }
  })();
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`🚀 Export service on port ${PORT}`);
});