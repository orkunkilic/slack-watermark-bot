require('dotenv').config();
const { App } = require('@slack/bolt');
const { WebClient } = require('@slack/web-api');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');
const { convert } = require('pdf-poppler');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

const tmpDir = './tmp';
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);

// Add watermark to PDF
async function addWatermark(input, output, watermarkText) {
  const bytes = fs.readFileSync(input);
  const pdfDoc = await PDFDocument.load(bytes);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const pages = pdfDoc.getPages();

  pages.forEach((page) => {
    const { width, height } = page.getSize();
    page.drawText(`CONFIDENTIAL • ${watermarkText}`, {
      x: width / 2 - 250,
      y: height / 3,
      size: 36,
      font,
      color: rgb(0.75, 0.75, 0.75),
      rotate: degrees(45),
      opacity: 0.3,
    });
  });

  const outputBytes = await pdfDoc.save();
  fs.writeFileSync(output, outputBytes);
}

// Convert PDF to PNGs and reassemble
async function flattenPDF(pdfPath, outputPath) {
  const pngDir = path.join(tmpDir, `png_${Date.now()}`);
  fs.mkdirSync(pngDir);

  await convert(pdfPath, {
    format: 'png',
    out_dir: pngDir,
    out_prefix: 'page',
    page: null,
  });

  const images = fs.readdirSync(pngDir).filter(f => f.endsWith('.png')).sort();
  const pdfDoc = await PDFDocument.create();

  for (const imgFile of images) {
    const imgBytes = fs.readFileSync(path.join(pngDir, imgFile));
    const image = await pdfDoc.embedPng(imgBytes);
    const page = pdfDoc.addPage([image.width, image.height]);
    page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  }

  const pdfBytes = await pdfDoc.save();
  fs.writeFileSync(outputPath, pdfBytes);
}

app.command('/watermark', async ({ command, ack, respond, client }) => {
  await ack();

  const watermark = command.text.trim();
  if (!watermark) return respond("❗ Please provide watermark text: `/watermark john@example.com`");

  const result = await client.files.list({ user: command.user_id });
  const pdf = result.files.find(f => f.filetype === 'pdf');

  if (!pdf) return respond("❌ No PDF found in recent uploads. Please upload a PDF first.");

  const inputPath = `${tmpDir}/${pdf.id}_original.pdf`;
  const watermarkedPath = `${tmpDir}/${pdf.id}_watermarked.pdf`;
  const finalPath = `${tmpDir}/${pdf.id}_flattened.pdf`;

  const fileRes = await fetch(pdf.url_private_download, {
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
  });
  const buffer = await fileRes.buffer();
  fs.writeFileSync(inputPath, buffer);

  await addWatermark(inputPath, watermarkedPath, `Shared with: ${watermark}`);
  await flattenPDF(watermarkedPath, finalPath);

  const upload = await client.files.upload({
    channels: command.channel_id,
    file: fs.createReadStream(finalPath),
    title: `📄 Watermarked PDF for ${watermark}`,
  });

  respond(`✅ Uploaded watermarked PDF: ${upload.file.permalink}`);
});

(async () => {
  await app.start(process.env.PORT || 3000);
  console.log('🚀 Slack watermark bot running');
})();